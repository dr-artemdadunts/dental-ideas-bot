require('dotenv').config();
const http = require('http');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const { Client: NotionClient } = require('@notionhq/client');

const REQUIRED_ENV_VARS = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
  'ANTHROPIC_API_KEY',
  'NOTION_TOKEN',
  'NOTION_IDEAS_DB_ID',
  'NOTION_PROFILE_PAGE_ID',
];

const missingEnvVars = REQUIRED_ENV_VARS.filter(name => !process.env[name]);
if (missingEnvVars.length > 0) {
  console.error(
    `❌ Бот не может запуститься: не заданы переменные окружения: ${missingEnvVars.join(', ')}.\n` +
    'Проверь Railway → Variables и добавь недостающие значения, затем передеплой сервис.'
  );
  process.exit(1);
}

let botStarted = false;
process.on('unhandledRejection', (reason) => {
  console.error('❌ Необработанная ошибка:', reason?.message || reason);
  if (!botStarted) {
    process.exit(1);
  }
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// ID модели можно переопределить переменной окружения ANTHROPIC_MODEL в Railway —
// это позволяет обновить модель без редеплоя кода, когда Anthropic ретайрит старую версию.
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });

// Без явного таймаута зависший внешний запрос (Notion/Anthropic) может
// заморозить весь /ideas молча, без единой строки в логах.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Таймаут: ${label} не ответил за ${ms}мс`)), ms)),
  ]);
}

// ── Notion helpers ────────────────────────────────────────────────────────────

// Профиль врача — теперь один-единственный, живёт как обычная Notion-страница
// (не база данных), которую врач редактирует вручную прямо в Notion.
// Бот читает страницу заново при каждом /ideas, так что правки применяются сразу,
// без передеплоя. Формат: заголовок (## Поле) + текст/список под ним.
const PROFILE_FIELD_MAP = {
  'имя': 'name',
  'специализация': 'specialization',
  'голос — как говорю': 'voice',
  'голос — чего избегаю': 'avoid',
  'голос — что заходит': 'works',
  'голос — не делаю в кадре': 'notOnCamera',
};

function blockPlainText(block) {
  const richText = block[block.type]?.rich_text || [];
  return richText.map(t => t.plain_text).join('');
}

async function getDoctorProfile() {
  const fallback = { name: 'Доктор', specialization: '🦷 Терапия, 🪥 Гигиена', voice: '', avoid: '', works: '', notOnCamera: '' };
  try {
    const res = await withTimeout(
      notion.blocks.children.list({ block_id: process.env.NOTION_PROFILE_PAGE_ID, page_size: 100 }),
      20000,
      'Notion getDoctorProfile',
    );
    const profile = {};
    let currentKey = null;
    for (const block of res.results) {
      if (block.type?.startsWith('heading_')) {
        const headingText = blockPlainText(block).trim().toLowerCase();
        currentKey = PROFILE_FIELD_MAP[headingText] || null;
        continue;
      }
      if (!currentKey) continue;
      const text = blockPlainText(block).trim();
      if (!text || text.startsWith('(')) continue; // пропускаем плейсхолдеры "(заполнить: ...)"
      profile[currentKey] = profile[currentKey] ? `${profile[currentKey]}\n${text}` : text;
    }
    return { ...fallback, ...profile };
  } catch (e) {
    console.error('Notion getDoctorProfile error:', e.message);
    return fallback;
  }
}

let cachedIdeasDbUrl = null;
async function getIdeasDbUrl() {
  if (cachedIdeasDbUrl) return cachedIdeasDbUrl;
  try {
    const db = await withTimeout(notion.databases.retrieve({ database_id: process.env.NOTION_IDEAS_DB_ID }), 20000, 'Notion getIdeasDbUrl');
    cachedIdeasDbUrl = db.url;
  } catch (e) {
    console.error('Notion getIdeasDbUrl error:', e.message);
    cachedIdeasDbUrl = `https://www.notion.so/${process.env.NOTION_IDEAS_DB_ID.replace(/-/g, '')}`;
  }
  return cachedIdeasDbUrl;
}

async function saveIdea(idea, authorName) {
  const scriptText = idea.script || '';
  const whyText = idea.why || '';
  await withTimeout(notion.pages.create({
    parent: { database_id: process.env.NOTION_IDEAS_DB_ID },
    properties: {
      'Тема': { title: [{ text: { content: idea.topic } }] },
      'Автор': { select: { name: authorName } },
      'Формат': { select: { name: idea.format } },
      'Источник': { select: { name: idea.source } },
      'Статус': { select: { name: '💡 Идея' } },
      'Хук': { rich_text: [{ text: { content: idea.hook || '' } }] },
      'Почему зайдёт': { rich_text: [{ text: { content: whyText } }] },
    },
    children: scriptText ? [
      {
        object: 'block',
        type: 'heading_3',
        heading_3: { rich_text: [{ type: 'text', text: { content: 'Сценарий' } }] },
      },
      {
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: scriptText } }] },
      },
    ] : [],
  }), 20000, 'Notion saveIdea');
}

// ── Claude + Tavily ───────────────────────────────────────────────────────────

const tools = [
  {
    name: 'web_search',
    description: 'Search the internet for current dental trends, patient questions, and content ideas.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
];

async function tavilySearch(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // без таймаута fetch может зависнуть навсегда и заморозить весь /ideas
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: 5, search_depth: 'basic' }),
      signal: controller.signal,
    });
    const data = await res.json();
    return (data.results || []).map(r => `${r.title}\n${r.url}\n${r.content}`).join('\n\n');
  } finally {
    clearTimeout(timeout);
  }
}

async function generateIdeas({ count, focus, profile, userName }) {
  const spec = profile?.specialization || '🦷 Терапия, 🪥 Гигиена';
  const voiceInfo = profile ? `
Голос врача:
- Как говорит: ${profile.voice || 'не указано'}
- Чего избегает: ${profile.avoid || 'не указано'}
- Что заходит у аудитории: ${profile.works || 'не указано'}
- Не делает в кадре: ${profile.notOnCamera || 'не указано'}` : '';

  const prompt = `Ты — опытный контент-продюсер и сценарист для медицинских экспертов в Instagram/TikTok. Ты работаешь с врачом-стоматологом и создаёшь контент, который реально набирает просмотры и строит доверие пациентов.

ПРОФИЛЬ ВРАЧА:
Имя: ${profile?.name || userName}
Специализация: ${spec}${voiceInfo}
${focus ? `Фокус этой недели: ${focus}` : ''}

ЗАДАЧА: Сгенерируй ровно ${count} готовых контент-идей.

ОБЯЗАТЕЛЬНЫЕ ШАГИ ПЕРЕД ГЕНЕРАЦИЕЙ:
1. Используй web_search чтобы найти актуальные вопросы пациентов на форумах и в комментариях (запрос: "${spec} вопросы пациентов форум 2024 2025")
2. Используй web_search чтобы найти что сейчас вирусится у стоматологов в СНГ (запрос: "стоматолог instagram reels тренды СНГ")
3. Используй web_search для поиска свежих исследований по специализации врача

ТРЕБОВАНИЯ К КАЖДОЙ ИДЕЕ:
- Конкретная, не абстрактная — не "про кариес", а "почему кариес появляется снова через год после лечения"
- Хук — первые 3 секунды видео или первое предложение поста, должен остановить скролл. Используй формулы: страх/ошибка/факт-шок/вопрос-провокация/личная история
- Сценарий — конкретные 3-5 тезиса что говорить, не общие слова
- Угол — неочевидный взгляд на тему, который отличает этого врача от других
- Эмоция — какую эмоцию вызывает у пациента: страх→облегчение, стыд→принятие, незнание→озарение

ФОРМАТЫ (выбирай исходя из темы):
- "🎬 Reels 30 сек" — один факт/ответ на вопрос, быстро и чётко
- "🎬 Reels 60 сек" — мини-история или разбор мифа с примером
- "🎠 Карусель" — пошаговые инструкции, сравнения, списки
- "📝 Пост" — личная история, кейс пациента, экспертное мнение
- "🔬 Научная ветка" — разбор исследования простым языком

ИСТОЧНИКИ:
- "💬 Вопрос пациента" — реальный вопрос который задают на приёме или в интернете
- "🔥 Тренд" — тема которая сейчас актуальна в соцсетях или новостях
- "🕵️ Конкурент" — тема которую делают другие, но можно сделать лучше/глубже
- "🔬 PubMed" — свежее исследование переведённое на человеческий язык
- "💡 Своя идея" — уникальный опыт или наблюдение врача

СТРОГИЕ ОГРАНИЧЕНИЯ:
- Только темы строго по специализации врача
- Только СНГ-контекст: реалии, менталитет, страхи пациентов из России/Украины/Казахстана
- БЕЗ тем про цены и стоимость
- БЕЗ западных трендов без адаптации под СНГ
- Хук должен быть написан готовым текстом, не описанием

Верни ТОЛЬКО валидный JSON массив без markdown и пояснений:
[{
  "topic": "точная формулировка темы",
  "format": "один из форматов выше",
  "source": "один из источников выше",
  "hook": "готовый текст хука — первые слова видео или поста",
  "why": "почему зайдёт: какую боль/страх/интерес задевает",
  "script": "3-5 конкретных тезисов через • что говорить в этом контенте"
}]`;

  // Грубая оценка цены по прайсу claude-sonnet-4-6 ($3/$15 за 1M токенов) —
  // если модель другая, цифра будет неточной, но порядок величины виден.
  function logUsage(label, usage) {
    if (!usage) return;
    const inTok = usage.input_tokens || 0;
    const outTok = usage.output_tokens || 0;
    const cost = (inTok / 1e6) * 3 + (outTok / 1e6) * 15;
    console.log(`[usage] ${label}: in=${inTok} out=${outTok} ~$${cost.toFixed(4)}`);
  }

  // Claude иногда оборачивает JSON в markdown-код-блок (```json ... ```) или
  // добавляет пояснения до/после массива, несмотря на просьбу так не делать.
  // Вместо того чтобы гадать про конкретный формат обёртки — просто вырезаем
  // подстроку от первой "[" до последней "]" включительно.
  function extractJsonArray(raw) {
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) return raw.trim();
    return raw.slice(start, end + 1);
  }

  const MAX_TOOL_ROUNDS = 2; // ограничиваем расходы на web_search — каждый раунд пересылает всю историю заново

  let messages = [{ role: 'user', content: prompt }];
  let response = await withTimeout(anthropic.messages.create({ model: CLAUDE_MODEL, max_tokens: 8000, tools, messages }), 60000, 'Anthropic initial');
  logUsage('initial', response.usage);

  let toolRounds = 0;
  while (response.stop_reason === 'tool_use' && toolRounds < MAX_TOOL_ROUNDS) {
    toolRounds++;
    // Claude может вызвать несколько инструментов параллельно за один ответ —
    // на каждый tool_use блок обязательно нужен свой tool_result, иначе 400.
    const toolUses = response.content.filter(b => b.type === 'tool_use');
    const toolResults = await Promise.all(toolUses.map(async (toolUse) => {
      let toolResult = '';
      if (toolUse.name === 'web_search') {
        try { toolResult = await tavilySearch(toolUse.input.query); }
        catch (e) { toolResult = 'Поиск недоступен: ' + e.message; }
      }
      return { type: 'tool_result', tool_use_id: toolUse.id, content: toolResult };
    }));
    messages = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResults },
    ];
    response = await withTimeout(anthropic.messages.create({ model: CLAUDE_MODEL, max_tokens: 8000, tools, messages }), 60000, `Anthropic tool round ${toolRounds}`);
    logUsage(`tool round ${toolRounds}`, response.usage);
  }

  // Если лимит раундов поиска исчерпан, а Claude всё ещё просит искать —
  // принудительно завершаем без дальнейших tool-запросов.
  if (response.stop_reason === 'tool_use') {
    const toolUses = response.content.filter(b => b.type === 'tool_use');
    const toolResults = toolUses.map(toolUse => ({
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: 'Лимит поисков исчерпан — отвечай на основе того, что уже нашёл.',
    }));
    messages = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResults },
    ];
  }

  // claude-sonnet-4-6 не поддерживает prefill ассистента (400 invalid_request_error),
  // поэтому финальный вызов идёт без tools с жёсткой текстовой инструкцией,
  // а извлечение JSON опирается на extractJsonArray (bracket-extraction).
  messages = [
    ...messages,
    { role: 'user', content: 'Верни ТОЛЬКО JSON массив, без markdown-обёртки (без ```), без пояснений до или после. Ответ должен начинаться сразу с символа [.' },
  ];
  const finalResp = await withTimeout(anthropic.messages.create({ model: CLAUDE_MODEL, max_tokens: 8000, messages }), 60000, 'Anthropic final');
  logUsage('final', finalResp.usage);

  if (finalResp.stop_reason === 'max_tokens') {
    console.error('[generateIdeas] финальный ответ обрезан по max_tokens — увеличь лимит или уменьши count');
  }

  const finalText = finalResp.content.find(b => b.type === 'text')?.text || '[]';
  try {
    return JSON.parse(extractJsonArray(finalText));
  } catch (e) {
    console.error('JSON parse error. stop_reason:', finalResp.stop_reason, '| raw text (first 300 + last 300 chars):', finalText.slice(0, 300), '...', finalText.slice(-300));
    throw e;
  }
}

// ── Messaging helpers ─────────────────────────────────────────────────────────

// Пытается отредактировать/отправить ответ на интеракцию; если это по какой-то
// причине невозможно (например, истёк 15-минутный webhook-токен на очень долгой
// генерации), пишет пользователю в личку вместо тихого падения.
async function safeRespond(interaction, payload) {
  try {
    if (interaction.replied || interaction.deferred) {
      return await interaction.editReply(payload);
    }
    return await interaction.reply(payload);
  } catch (err) {
    console.error('[safeRespond] не удалось ответить на интеракцию:', err.message);
    try {
      return await interaction.user.send(payload);
    } catch (dmErr) {
      console.error('[safeRespond] личка тоже не сработала:', dmErr.message);
      throw dmErr;
    }
  }
}

// ── Slash-команды ─────────────────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('ideas')
    .setDescription('Сгенерировать контент-идеи для соцсетей')
    .addIntegerOption(opt =>
      opt.setName('count')
        .setDescription('Сколько идей сгенерировать (1-10)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(10))
    .addStringOption(opt =>
      opt.setName('focus')
        .setDescription('Фокус недели (необязательно), например: профилактика кариеса у взрослых')
        .setRequired(false))
    .toJSON(),
];

async function registerCommands() {
  const rest = new REST().setToken(process.env.DISCORD_BOT_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
    { body: commands },
  );
  console.log('✅ Slash-команды зарегистрированы');
}

// ── Discord-клиент ────────────────────────────────────────────────────────────

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function ideasToEmbed(ideas, displayName) {
  const embed = new EmbedBuilder()
    .setTitle(`✅ ${ideas.length} идей для ${displayName}`)
    .setColor(0x2ecc71);

  for (const [i, idea] of ideas.entries()) {
    const scriptText = (idea.script || idea.why || '').slice(0, 700);
    embed.addFields({
      name: `${i + 1}. ${idea.topic}`.slice(0, 256),
      value: `${idea.format} · ${idea.source}\n💬 *Хук:* ${idea.hook}\n📋 *Сценарий:* ${scriptText}`.slice(0, 1024),
    });
  }
  return embed;
}

client.on('interactionCreate', async (interaction) => {
  try {
    // ── /ideas ──────────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'ideas') {
      const count = interaction.options.getInteger('count', true);
      const focus = interaction.options.getString('focus') || '';
      const userName = interaction.user.username;

      await interaction.deferReply();
      await interaction.editReply(`⏳ Генерирую ${count} идей${focus ? ` по теме «${focus}»` : ''}...`);
      console.log(`[/ideas] старт: user=${userName} count=${count} focus="${focus}"`);

      const profile = await getDoctorProfile();
      console.log('[/ideas] профиль получен');
      const ideas = await generateIdeas({ count, focus, profile, userName });
      console.log(`[/ideas] сгенерировано идей: ${ideas.length}`);

      for (const idea of ideas) {
        try { await saveIdea(idea, profile.name); }
        catch (e) { console.error('Notion saveIdea error:', e.message); }
      }
      console.log('[/ideas] идеи сохранены в Notion');

      const notionUrl = await getIdeasDbUrl();
      const embed = ideasToEmbed(ideas, profile.name);

      await safeRespond(interaction, {
        content: `Готово! 📋 [Открыть все идеи в Notion](${notionUrl})`,
        embeds: [embed],
      });
      return;
    }
  } catch (err) {
    console.error('[interactionCreate] необработанная ошибка:', err);
    try {
      await safeRespond(interaction, { content: `❌ Ошибка: ${err.message}` });
    } catch (notifyErr) {
      console.error('[interactionCreate] не удалось уведомить пользователя:', notifyErr.message);
    }
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

// Лёгкий HTTP-сервер только для health-check Railway — Discord-клиент работает
// через WebSocket (Gateway) и сам по себе HTTP не поднимает.
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}).listen(port, () => console.log(`Health-check сервер слушает порт ${port}`));

(async () => {
  try {
    await registerCommands();
    await client.login(process.env.DISCORD_BOT_TOKEN);
    client.once('ready', () => {
      botStarted = true;
      console.log(`✅ Бот запущен как ${client.user.tag}`);
    });
  } catch (err) {
    console.error('❌ Не удалось запустить бота:', err.message);
    process.exit(1);
  }
})();
