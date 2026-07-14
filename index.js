require('dotenv').config();
const http = require('http');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
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
  'NOTION_PROFILES_DB_ID',
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

const SPECIALIZATIONS = ['🦷 Терапия', '🪥 Гигиена', '🦴 Ортопедия', '🔬 Пародонтология', '😁 Эстетика'];

// ── Notion helpers ────────────────────────────────────────────────────────────
// Примечание: свойство в Notion по-прежнему называется "Slack ID" — это просто
// текстовое поле для внешнего ID пользователя, теперь в нём хранится Discord ID.
// Переименовать колонку в Notion можно в любой момент, на логику это не влияет.

async function getProfile(discordId) {
  try {
    const res = await notion.databases.query({
      database_id: process.env.NOTION_PROFILES_DB_ID,
      filter: { property: 'Slack ID', rich_text: { equals: discordId } },
    });
    if (res.results.length === 0) return null;
    const page = res.results[0];
    const p = page.properties;
    return {
      id: page.id,
      name: p['Имя']?.title?.[0]?.plain_text || '',
      specialization: p['Специализация']?.multi_select?.map(s => s.name).join(', ') || '',
      voice: p['Голос — как говорю']?.rich_text?.[0]?.plain_text || '',
      avoid: p['Голос — чего избегаю']?.rich_text?.[0]?.plain_text || '',
      works: p['Голос — что заходит']?.rich_text?.[0]?.plain_text || '',
      notOnCamera: p['Голос — не делаю в кадре']?.rich_text?.[0]?.plain_text || '',
    };
  } catch (e) {
    console.error('Notion getProfile error:', e.message);
    return null;
  }
}

async function upsertProfile(discordId, userName, fields) {
  const existing = await getProfile(discordId);
  const props = {
    'Имя': { title: [{ text: { content: fields.name || userName } }] },
    'Slack ID': { rich_text: [{ text: { content: discordId } }] },
    'Специализация': { multi_select: (fields.specialization || []).map(s => ({ name: s })) },
    'Голос — как говорю': { rich_text: [{ text: { content: fields.voice || '' } }] },
    'Голос — чего избегаю': { rich_text: [{ text: { content: fields.avoid || '' } }] },
    'Голос — что заходит': { rich_text: [{ text: { content: fields.works || '' } }] },
    'Голос — не делаю в кадре': { rich_text: [{ text: { content: fields.notOnCamera || '' } }] },
  };
  if (existing) {
    await notion.pages.update({ page_id: existing.id, properties: props });
  } else {
    await notion.pages.create({
      parent: { database_id: process.env.NOTION_PROFILES_DB_ID },
      properties: props,
    });
  }
}

let cachedIdeasDbUrl = null;
async function getIdeasDbUrl() {
  if (cachedIdeasDbUrl) return cachedIdeasDbUrl;
  try {
    const db = await notion.databases.retrieve({ database_id: process.env.NOTION_IDEAS_DB_ID });
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
  await notion.pages.create({
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
  });
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
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: 5, search_depth: 'basic' }),
  });
  const data = await res.json();
  return (data.results || []).map(r => `${r.title}\n${r.url}\n${r.content}`).join('\n\n');
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

  let messages = [{ role: 'user', content: prompt }];
  let response = await anthropic.messages.create({ model: CLAUDE_MODEL, max_tokens: 8000, tools, messages });

  while (response.stop_reason === 'tool_use') {
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
    response = await anthropic.messages.create({ model: CLAUDE_MODEL, max_tokens: 8000, tools, messages });
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

  if (response.stop_reason === 'max_tokens') {
    console.error('[generateIdeas] ответ обрезан по max_tokens — увеличь лимит или уменьши count');
  }

  const text = response.content.find(b => b.type === 'text')?.text || '[]';
  try {
    return JSON.parse(extractJsonArray(text));
  } catch (e) {
    console.error('JSON parse error, retrying. stop_reason:', response.stop_reason, '| raw text (first 300 + last 300 chars):', text.slice(0, 300), '...', text.slice(-300));
    messages = [...messages, { role: 'assistant', content: response.content }, { role: 'user', content: 'Верни ТОЛЬКО JSON массив без пояснений и markdown.' }];
    const retry = await anthropic.messages.create({ model: CLAUDE_MODEL, max_tokens: 8000, messages });
    if (retry.stop_reason === 'max_tokens') {
      console.error('[generateIdeas] retry тоже обрезан по max_tokens');
    }
    const retryText = retry.content.find(b => b.type === 'text')?.text || '[]';
    try {
      return JSON.parse(extractJsonArray(retryText));
    } catch (e2) {
      console.error('JSON parse error on retry too. stop_reason:', retry.stop_reason, '| raw text (first 300 + last 300 chars):', retryText.slice(0, 300), '...', retryText.slice(-300));
      throw e2;
    }
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
        .setDescription('Сколько идей сгенерировать')
        .setRequired(true)
        .addChoices(
          { name: '5 идей', value: 5 },
          { name: '8 идей', value: 8 },
          { name: '12 идей', value: 12 },
        ))
    .addStringOption(opt =>
      opt.setName('focus')
        .setDescription('Фокус недели (необязательно), например: профилактика кариеса у взрослых')
        .setRequired(false))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Настроить профиль врача для персонализации идей')
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

function buildProfileModal(existing, specialization) {
  const modal = new ModalBuilder()
    .setCustomId(`profile_modal:${encodeURIComponent(specialization.join(','))}`)
    .setTitle('👤 Мой профиль');

  const nameInput = new TextInputBuilder()
    .setCustomId('name')
    .setLabel('Имя (как отображать в Банке идей)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(existing?.name || '');

  const voiceInput = new TextInputBuilder()
    .setCustomId('voice')
    .setLabel('Как я говорю')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setValue(existing?.voice || '');

  const avoidInput = new TextInputBuilder()
    .setCustomId('avoid')
    .setLabel('Чего избегаю')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setValue(existing?.avoid || '');

  const worksInput = new TextInputBuilder()
    .setCustomId('works')
    .setLabel('Что заходит у аудитории')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setValue(existing?.works || '');

  const notOnCameraInput = new TextInputBuilder()
    .setCustomId('notOnCamera')
    .setLabel('Не делаю в кадре')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setValue(existing?.notOnCamera || '');

  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(voiceInput),
    new ActionRowBuilder().addComponents(avoidInput),
    new ActionRowBuilder().addComponents(worksInput),
    new ActionRowBuilder().addComponents(notOnCameraInput),
  );
  return modal;
}

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
      const userId = interaction.user.id;
      const userName = interaction.user.username;

      await interaction.deferReply();
      await interaction.editReply(`⏳ Генерирую ${count} идей${focus ? ` по теме «${focus}»` : ''}...`);

      const profile = await getProfile(userId);
      const defaultProfile = profile || { name: userName, specialization: '🦷 Терапия, 🪥 Гигиена' };
      const ideas = await generateIdeas({ count, focus, profile: defaultProfile, userName });

      for (const idea of ideas) {
        try { await saveIdea(idea, defaultProfile.name || userName); }
        catch (e) { console.error('Notion saveIdea error:', e.message); }
      }

      const notionUrl = await getIdeasDbUrl();
      const embed = ideasToEmbed(ideas, defaultProfile.name || userName);

      await safeRespond(interaction, {
        content: `Готово! 📋 [Открыть все идеи в Notion](${notionUrl})`,
        embeds: [embed],
      });
      return;
    }

    // ── /profile ────────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'profile') {
      const existing = await getProfile(interaction.user.id);
      const select = new StringSelectMenuBuilder()
        .setCustomId('profile_spec_select')
        .setPlaceholder('Выбери специализацию')
        .setMinValues(0)
        .setMaxValues(SPECIALIZATIONS.length)
        .addOptions(SPECIALIZATIONS.map(s => ({
          label: s,
          value: s,
          default: (existing?.specialization || '').split(', ').includes(s),
        })));

      await interaction.reply({
        content: 'Шаг 1/2 — выбери специализацию, затем откроется форма с остальными полями:',
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true,
      });
      return;
    }

    // ── шаг 2 профиля: выбор специализации → модалка с текстовыми полями ────
    if (interaction.isStringSelectMenu() && interaction.customId === 'profile_spec_select') {
      const existing = await getProfile(interaction.user.id);
      await interaction.showModal(buildProfileModal(existing, interaction.values));
      return;
    }

    // ── шаг 3 профиля: сабмит модалки → сохранение в Notion ─────────────────
    if (interaction.isModalSubmit() && interaction.customId.startsWith('profile_modal:')) {
      const specialization = decodeURIComponent(interaction.customId.split(':')[1] || '')
        .split(',')
        .filter(Boolean);
      const nameVal = interaction.fields.getTextInputValue('name') || interaction.user.username;

      try {
        await upsertProfile(interaction.user.id, interaction.user.username, {
          name: nameVal,
          specialization,
          voice: interaction.fields.getTextInputValue('voice') || '',
          avoid: interaction.fields.getTextInputValue('avoid') || '',
          works: interaction.fields.getTextInputValue('works') || '',
          notOnCamera: interaction.fields.getTextInputValue('notOnCamera') || '',
        });
        await interaction.reply({ content: '✅ Профиль обновлён!', ephemeral: true });
      } catch (err) {
        console.error('profile_modal error:', err);
        await interaction.reply({ content: `❌ Ошибка: ${err.message}`, ephemeral: true });
      }
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
