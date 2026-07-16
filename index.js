require('dotenv').config();
const http = require('http');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
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
  await withTimeout(notion.pages.create({
    parent: { database_id: process.env.NOTION_IDEAS_DB_ID },
    properties: {
      'Тема': { title: [{ text: { content: idea.topic } }] },
      'Автор': { select: { name: authorName } },
      'Формат': { select: { name: idea.format } },
      'Источник': { select: { name: idea.source } },
      'Статус': { select: { name: '💡 Идея' } },
      'Хук': { rich_text: [{ text: { content: idea.hook || '' } }] },
      'Почему зайдёт': { rich_text: [{ text: { content: idea.why || '' } }] },
    },
  }), 20000, 'Notion saveIdea');
}

// Идеи со статусом "❌ Отклонено" автоматически удаляются (архивируются) через
// минуту после отклонения — проверяем last_edited_time страницы, т.к. он
// обновляется в момент смены статуса и не требует отдельного свойства-даты.
const REJECTED_STATUS = '❌ Отклонено';
const REJECTED_TTL_MS = 60 * 1000;

async function cleanupRejectedIdeas() {
  try {
    const res = await withTimeout(notion.databases.query({
      database_id: process.env.NOTION_IDEAS_DB_ID,
      filter: { property: 'Статус', select: { equals: REJECTED_STATUS } },
    }), 20000, 'Notion cleanupRejectedIdeas query');

    const now = Date.now();
    for (const page of res.results) {
      const editedAt = new Date(page.last_edited_time).getTime();
      if (now - editedAt < REJECTED_TTL_MS) continue;
      await withTimeout(notion.pages.update({ page_id: page.id, archived: true }), 20000, 'Notion cleanupRejectedIdeas archive');
      console.log(`[cleanup] удалена отклонённая идея: ${page.id}`);
    }
  } catch (e) {
    console.error('cleanupRejectedIdeas error:', e.message);
  }
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
// добавляет пояснения до/после, несмотря на просьбу так не делать. Вместо того
// чтобы гадать про конкретный формат обёртки — просто вырезаем подстроку
// между первой и последней открывающей/закрывающей скобкой нужного типа.
function extractJsonArray(raw) {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return raw.trim();
  return raw.slice(start, end + 1);
}

function extractJsonObject(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return raw.trim();
  return raw.slice(start, end + 1);
}

function buildVoiceInfo(profile) {
  return profile ? `
Голос врача:
- Как говорит: ${profile.voice || 'не указано'}
- Чего избегает: ${profile.avoid || 'не указано'}
- Что заходит у аудитории: ${profile.works || 'не указано'}
- Не делает в кадре: ${profile.notOnCamera || 'не указано'}` : '';
}

// Notion rich_text/title — массив кусков текста, склеиваем в одну строку.
function plainText(richTextArray) {
  return (richTextArray || []).map(t => t.plain_text).join('');
}

function chunkText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks.length ? chunks : [''];
}

async function generateIdeas({ count, focus, format, audience, profile, userName }) {
  const spec = profile?.specialization || '🦷 Терапия, 🪥 Гигиена';
  const voiceInfo = buildVoiceInfo(profile);
  const currentYear = new Date().getFullYear();

  const prompt = `Ты — крео-директор, который 5 лет ведёт контент топовых стоматологов в СНГ (клиенты
стабильно набирают 100K+ подписчиков), лично отсмотрел тысячи Reels в медицинской
нише и точно знаешь, что держит досмотр, а что выглядит как дефолтный
ИИ-контент — и презираешь второе.

ПРОФИЛЬ ВРАЧА:
Имя: ${profile?.name || userName}
Специализация: ${spec}${voiceInfo}
${focus ? `Фокус этой недели: ${focus}` : ''}
${format ? `ЗАФИКСИРОВАННЫЙ ФОРМАТ: генерируй ВСЕ идеи строго в формате "${format}". Не отклоняйся от него.` : ''}
${audience ? `ЦЕЛЕВОЙ СЕГМЕНТ: все идеи должны бить в сегмент "${audience}". Каждый хук и триггер затачивай именно под него.` : ''}

ЗАДАЧА: Придумай ровно ${count} идей, которые ты бы поставил в свой личный
портфолио, а не идей "для галочки".

ГЛАВНЫЙ САМОПРОВЕРОЧНЫЙ ВОПРОС — задавай его к КАЖДОЙ идее перед тем как
включить её в финальный список: "Я бы реально сегодня взял камеру и
захотел снять именно это?" Если ответ "ну, наверное, сойдёт" — это НЕТ.
Идея должна вызывать конкретное желание снимать прямо сейчас, а не быть
приемлемой заглушкой. Если идея не проходит этот вопрос — выброси её и
придумай другую, не включай в ответ.

ОБЯЗАТЕЛЬНЫЕ ШАГИ ПЕРЕД ГЕНЕРАЦИЕЙ:
1. web_search: реальные вопросы пациентов на форумах/в комментариях
   ("${spec} вопросы пациентов форум ${currentYear} ${currentYear - 1}")
2. web_search: что сейчас вирусится у стоматологов в СНГ
   ("стоматолог instagram reels тренды СНГ ${currentYear}")
3. web_search: свежие исследования по специализации врача

ПЛАНКА НОВИЗНЫ (жёсткий фильтр — применяй к каждой идее перед тем как её выдать):
Идея допустима только если несёт факт/механизм/цифру, которую средний пациент
НЕ знает. Спроси себя: "это уже видели миллион раз в любом дентал-блоге?" —
если да, выброси идею и придумай другую.

ХУК — ГОТОВЫЙ ТЕКСТ, НЕ ОПИСАНИЕ ФОРМУЛЫ. Используй один из фреймворков,
вот примеры того, как это звучит (это ЭТАЛОН ТОНА, не копируй буквально):
- Разрыв ожидания: "Ты купил ирригатор — молодец. Но если ты выбросил зубную
  нить, у меня плохие новости."
- Неудобная правда: "Если у тебя когда-то был скол на переднем зубе и тебе
  поставили пломбу — она потемнеет раньше, чем ты думаешь. Это не брак
  врача. Это физика материала."
- Инсайдерский секрет: "На приёме я вижу одно и то же почти каждый день:
  люди чистят зубы щёткой средней жёсткости, потому что 'она средняя —
  значит безопасная'. Это не так."
- Паттерн-брейк цифрой: "80% людей держат зубную щётку под углом, который
  не убирает налёт у линии дёсен. Не потому что чистят мало — а потому что
  чистят не туда."
- Личная ставка: "Пять лет назад я сам не пользовался ирригатором. Думал —
  маркетинговая штука. Сейчас настоятельно рекомендую его пациентам, и вот
  почему я был неправ."

Хук должен нести не просто цепляющую фразу, а обещание дуги: зацепка →
нерешённое напряжение → намёк на разрешение. Зритель должен физически
не суметь долистать, потому что вопрос в голове ещё открыт.

АУДИТОРИЯ: для каждой идеи явно пойми, на какой сегмент она бьёт —
тревожный пациент ("боюсь, что что-то не так"), проактивный
("хочу быть лучшей версией себя") или скептик ("врачи разводят на деньги").
Идея "для всех" — это идея ни для кого, будь конкретен.

ТРИГГЕР ("Почему зайдёт"): назови КОНКРЕТНЫЙ психологический рычаг, а не
общую фразу. Примеры формулировок: страх потери того, что уже есть (loss
aversion), угроза идентичности "я думал что делаю всё правильно",
любопытство от незакрытого гештальта, социальное доказательство
("все вокруг тоже так думают"). Плохо: "это интересно и полезно".

ЗАПРЕЩЕНО ГЕНЕРИРОВАТЬ (клише, которые Claude обожает и которые выглядят
как дефолтный ИИ-контент):
- "N ошибок при чистке зубов" / любой листикл без цифры-инсайта внутри
- "Врачи скрывают правду о..."
- Риторический вопрос-приманка в духе "У вас есть X? Тогда..." / "А вы
  знали, что..." — это клише само по себе, даже если дальше есть ответ
- "Это не про зубы, это про [нечто абстрактное]" и любые вариации этого
  шаблона ("это не про X, это про Y") — избитая копирайтерская формула
- "Смотрите/дочитайте до конца" и любые прямые команды зрителю остаться —
  так не говорит живой человек, это выдаёт ИИ с головой
- Рубленые предложения-обрывки подряд для псевдонапряжения ("Совсем.
  Никакой боли. А зуба внутри уже нет.") — пиши как говорит живой врач,
  не как драматический войсовер
- "Правда vs миф" без конкретного нового факта
- Общие советы без цифр/механизма ("чистите зубы регулярно")
- Дисклеймер-контент ("это не медицинская рекомендация, но...")

АНТИПРИМЕР (реальный забракованный хук — вот именно так писать НЕЛЬЗЯ):
"У вас есть пломба старше 7 лет? Тогда смотрите до конца — потому что
прямо сейчас под ней может идти кариес, и вы об этом ничего не
чувствуете. Совсем. Никакой боли. Пломба выглядит целой. А зуба внутри
уже нет."
Разбор почему это плохо: риторический вопрос-приманка + "смотрите до
конца" + рубленые предложения для драмы. Идея внутри неплохая (скрытый
кариес под старой пломбой), но подача — штампованный ИИ-контент.

ЭТИКА (это ограничитель, а не пожелание — соцсети банят такой контент):
- Никаких гарантий результата
- Никакого запугивания без медицинского основания
  ("если не сделать X — потеряешь все зубы")
- Никаких фейковых/непроверяемых медицинских утверждений ради вирусности

ФОРМАТЫ (выбирай исходя из темы, если формат не зафиксирован выше):
- "🎬 Reels 30 сек" — один факт/ответ на вопрос, быстро и чётко
- "🎬 Reels 60 сек" — мини-история или разбор мифа с примером
- "🎠 Карусель" — пошаговые инструкции, сравнения, списки
- "📝 Пост" — личная история, кейс пациента, экспертное мнение
- "🔬 Научная ветка" — разбор исследования простым языком

ИСТОЧНИКИ:
- "💬 Вопрос пациента" — реальный вопрос который задают на приёме/в интернете
- "🔥 Тренд" — тема которая сейчас актуальна в соцсетях или новостях
- "🕵️ Конкурент" — тема которую делают другие, но можно сделать лучше/глубже
- "🔬 PubMed" — свежее исследование переведённое на человеческий язык
- "💡 Своя идея" — уникальный опыт или наблюдение врача

СТРОГИЕ ОГРАНИЧЕНИЯ:
- Только темы строго по специализации врача
- Контекст: русскоговорящие релоканты в Армении. Это люди, оторванные от
  привычной клиники, в новой стране, не знающие местных реалий и не
  понимающие, кому здесь можно верить. Их страхи — не "а вдруг больно",
  а "а вдруг тут разведут / сделают хуже, чем дома / я не смогу проверить
  квалификацию". Учитывай это, а не общий менталитет СНГ.
- БЕЗ тем про цены и стоимость
- БЕЗ западных трендов без адаптации под эту аудиторию

Верни ТОЛЬКО валидный JSON массив без markdown и пояснений:
[{
  "topic": "точная формулировка темы",
  "format": "один из форматов выше",
  "source": "один из источников выше",
  "hook": "готовый текст хука — первые слова видео или поста",
  "why": "конкретный психологический триггер + на какой сегмент аудитории бьёт"
}]`;

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

// Пишет сценарий уже одобренной идеи (статус "✅ В работу") в двух стилях подачи.
// Сначала черновик, потом отдельный проход самокритики по чек-листу — модель
// перечитывает свой же текст и переписывает всё, что не проходит проверку,
// вместо того чтобы просто "стараться лучше" за один присест.
async function generateScripts(idea, profile) {
  const voiceInfo = buildVoiceInfo(profile);

  const draftPrompt = `Ты — тот же крео-директор, который придумал эту идею. Теперь напиши
РЕАЛЬНЫЙ сценарий, готовый к съёмке сегодня — точный текст, который врач
произнесёт на камеру слово в слово, а не тезисы и не план.

ИДЕЯ:
Тема: ${idea.topic}
Формат: ${idea.format}
Хук (уже готов, начни ровно с него, не переписывай): "${idea.hook}"
Почему заходит: ${idea.why}

ПРОФИЛЬ ВРАЧА:
Имя: ${profile?.name || ''}
Специализация: ${profile?.specialization || ''}${voiceInfo}

ЗАДАЧА: Напиши сценарий этой идеи в ДВУХ разных стилях подачи. Каждый стиль —
это ПОКАДРОВАЯ РАСКЛАДКА: список битов (beats), а не сплошной текст. Каждый
бит — конкретный отрезок ролика/поста с двумя параллельными частями: что
говорит врач (voiceover) и что происходит в кадре в этот момент (visual).

СТИЛИ (разница должна быть в СТРУКТУРЕ ПОДАЧИ, не только в словах):
1. "🗣️ Разговорный" — врач говорит как будто объясняет сидящему в кресле
   пациенту: от первого лица, живая интонация, можно короткое личное
   наблюдение с приёма ("я это вижу постоянно"). Кадр — крупный план лица,
   естественная жестикуляция, минимум текста на экране.
2. "🎓 Экспертный" — врач подаёт как лектор со структурой: чёткие тезисы,
   можно пронумеровать факты, термин + расшифровка простыми словами. В кадре
   допускается текстовая графика/подписи с цифрами или схема поверх кадра,
   более собранная подача, почти без "я", больше факта.

РАСКЛАДКА ПО ФОРМАТУ "${idea.format}":
- "🎬 Reels 30 сек" → 3 бита: 0–3 сек (хук ровно как дан), 3–20 сек
  (раскрытие/механизм), 20–30 сек (вывод + естественный call to action)
- "🎬 Reels 60 сек" → 4–5 битов с таймингом: хук → развитие → доказательство/
  пример → вывод
- "🎠 Карусель" → биты = слайды ("Слайд 1", "Слайд 2", ...), 5–7 слайдов; в
  voiceover — текст слайда, в visual — что на слайде визуально (иконка,
  диаграмма, крупная цифра и т.п.)
- "📝 Пост" / "🔬 Научная ветка" → биты = смысловые блоки без тайминга:
  "Зацепка", "Контекст", "Механизм/факт", "Вывод"; в voiceover — текст блока,
  visual можно оставить пустой строкой

ТРЕБОВАНИЯ:
- voiceover первого бита начинается РОВНО с хука выше, не переписывай его
- каждый voiceover — готовый текст слово в слово (для карусели/поста — текст,
  который читает зритель), не тезисы и не план
- последний бит — чёткий вывод, звучит естественно, не как реклама

ЗАПРЕЩЕНО (те же клише что и в хуках):
- "Смотрите/дочитайте до конца" и любые команды зрителю остаться
- "Это не про зубы, это про..." и вариации "это не про X, это про Y"
- Рубленые предложения-обрывки подряд для псевдонапряжения
- Риторические вопросы-приманки в начале ("А вы знали, что...")
- Общие советы без цифр/механизма

Верни ТОЛЬКО валидный JSON без markdown:
{"styles": [
  {"name": "🗣️ Разговорный", "beats": [
    {"label": "0–3 сек", "voiceover": "точный текст", "visual": "что в кадре"},
    {"label": "3–20 сек", "voiceover": "...", "visual": "..."},
    {"label": "20–30 сек", "voiceover": "...", "visual": "..."}
  ]},
  {"name": "🎓 Экспертный", "beats": [ ... та же структура ... ]}
]}`;

  const draftResp = await withTimeout(
    anthropic.messages.create({ model: CLAUDE_MODEL, max_tokens: 8000, messages: [{ role: 'user', content: draftPrompt }] }),
    60000, 'Anthropic script draft',
  );
  logUsage('script draft', draftResp.usage);
  const draftText = draftResp.content.find(b => b.type === 'text')?.text || '{}';
  let draft;
  try {
    draft = JSON.parse(extractJsonObject(draftText));
  } catch (e) {
    console.error('[generateScripts] draft JSON parse error:', e.message, '| raw:', draftText.slice(0, 300));
    throw e;
  }

  const critiquePrompt = `Вот черновик сценария, который ты только что написал для этой идеи:
${JSON.stringify(draft)}

Теперь критически проверь КАЖДЫЙ бит в КАЖДОМ стиле по чек-листу:
1. Есть хоть одно клише из бан-листа (рубленые фразы-обрывки, "смотрите до
   конца", "это не про X это про Y", риторический вопрос-приманка, общие
   советы без цифр/механизма)?
2. voiceover звучит как живая речь конкретного врача, а не как войсовер или
   методичка?
3. visual — это конкретное действие/кадр/графика, а не общая фраза вроде
   "врач говорит на камеру"?
4. "🗣️ Разговорный" и "🎓 Экспертный" реально различаются по СТРУКТУРЕ подачи
   (первое лицо/личный опыт vs тезисы/факты), а не только по словам?
5. Раскладка по битам соответствует формату "${idea.format}" (тайминг для
   Reels, слайды для карусели, смысловые блоки для поста/научной ветки)?
6. Есть в voiceover конкретный факт/механизм, а не только эмоция?

Перепиши всё, что не проходит проверку. Если стиль уже хорош — оставь как
есть, не порти правками ради правок.

Верни ТОЛЬКО финальный валидный JSON того же формата, без markdown:
{"styles": [
  {"name": "...", "beats": [{"label": "...", "voiceover": "...", "visual": "..."}]},
  {"name": "...", "beats": [{"label": "...", "voiceover": "...", "visual": "..."}]}
]}`;

  const critiqueResp = await withTimeout(
    anthropic.messages.create({ model: CLAUDE_MODEL, max_tokens: 8000, messages: [{ role: 'user', content: critiquePrompt }] }),
    60000, 'Anthropic script critique',
  );
  logUsage('script critique', critiqueResp.usage);
  const critiqueText = critiqueResp.content.find(b => b.type === 'text')?.text || '{}';
  try {
    const final = JSON.parse(extractJsonObject(critiqueText));
    return final.styles || draft.styles || [];
  } catch (e) {
    console.error('[generateScripts] critique JSON parse error, использую черновик:', e.message);
    return draft.styles || [];
  }
}

// Дописывает сценарии в конец страницы идеи в Notion — каждый стиль своим
// заголовком, текст режется на куски по лимиту rich_text (2000 символов у Notion).
function tableRow(cells) {
  return {
    object: 'block',
    type: 'table_row',
    // Notion отклоняет rich_text с пустым content — подставляем плейсхолдер вместо ''.
    table_row: { cells: cells.map(c => [{ type: 'text', text: { content: (c && c.trim()) ? c.slice(0, 1900) : '—' } }]) },
  };
}

async function saveScriptsToPage(pageId, styles) {
  const children = [];
  for (const style of styles) {
    children.push({
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: [{ type: 'text', text: { content: `Сценарий — ${style.name || ''}` } }] },
    });

    const beats = Array.isArray(style.beats) ? style.beats : [];
    if (beats.length > 0) {
      children.push({
        object: 'block',
        type: 'table',
        table: {
          table_width: 3,
          has_column_header: true,
          has_row_header: false,
          children: [
            tableRow(['Тайминг / блок', 'Говорим', 'В кадре']),
            ...beats.map(b => tableRow([b.label, b.voiceover, b.visual])),
          ],
        },
      });
    } else if (style.text) {
      // Фолбэк на случай, если модель вернула старый плоский формат.
      for (const chunk of chunkText(style.text, 1900)) {
        children.push({
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: chunk } }] },
        });
      }
    }
  }
  await withTimeout(notion.blocks.children.append({ block_id: pageId, children }), 20000, 'Notion saveScriptsToPage');
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
    .addStringOption(opt =>
      opt.setName('format')
        .setDescription('Зафиксировать формат для всех идей (необязательно)')
        .setRequired(false)
        .addChoices(
          { name: '🎬 Reels 30 сек', value: '🎬 Reels 30 сек' },
          { name: '🎬 Reels 60 сек', value: '🎬 Reels 60 сек' },
          { name: '🎠 Карусель', value: '🎠 Карусель' },
          { name: '📝 Пост', value: '📝 Пост' },
          { name: '🔬 Научная ветка', value: '🔬 Научная ветка' },
        ))
    .addStringOption(opt =>
      opt.setName('audience')
        .setDescription('Зафиксировать целевой сегмент для всех идей (необязательно)')
        .setRequired(false)
        .addChoices(
          { name: 'Тревожный пациент', value: 'тревожный пациент ("боюсь, что что-то не так")' },
          { name: 'Проактивный', value: 'проактивный ("хочу быть лучшей версией себя")' },
          { name: 'Скептик', value: 'скептик ("врачи разводят на деньги")' },
          { name: 'Смешанная (без прицела)', value: 'mixed' },
        ))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('develop')
    .setDescription('Написать сценарии для идей в статусе "✅ В работу"')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Опубликовать и закрепить панель с кнопками запуска бота в этом канале')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
];

// ── Панель с кнопками запуска ────────────────────────────────────────────────

function buildLauncherRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('launch_ideas')
      .setLabel('💡 Сгенерировать идеи')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('launch_develop')
      .setLabel('✍️ Написать сценарии')
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildIdeasModal() {
  return new ModalBuilder()
    .setCustomId('ideas_modal')
    .setTitle('Сгенерировать идеи')
    .addLabelComponents(
      label => label
        .setLabel('Сколько идей (1-10)')
        .setTextInputComponent(input => input
          .setCustomId('count')
          .setStyle(TextInputStyle.Short)
          .setValue('5')
          .setRequired(true)),
      label => label
        .setLabel('Фокус недели')
        .setTextInputComponent(input => input
          .setCustomId('focus')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)),
      label => label
        .setLabel('Формат')
        .setStringSelectMenuComponent(select => select
          .setCustomId('format')
          .setPlaceholder('Не выбрано — формат подберёт бот')
          .setMinValues(0)
          .setMaxValues(1)
          .addOptions(
            { label: '🎬 Reels 30 сек', value: '🎬 Reels 30 сек' },
            { label: '🎬 Reels 60 сек', value: '🎬 Reels 60 сек' },
            { label: '🎠 Карусель', value: '🎠 Карусель' },
            { label: '📝 Пост', value: '📝 Пост' },
            { label: '🔬 Научная ветка', value: '🔬 Научная ветка' },
          )),
      label => label
        .setLabel('Аудитория')
        .setStringSelectMenuComponent(select => select
          .setCustomId('audience')
          .setPlaceholder('Не выбрано — по умолчанию проактивный')
          .setMinValues(0)
          .setMaxValues(1)
          .addOptions(
            { label: 'Тревожный пациент', value: 'тревожный пациент ("боюсь, что что-то не так")' },
            { label: 'Проактивный', value: 'проактивный ("хочу быть лучшей версией себя")' },
            { label: 'Скептик', value: 'скептик ("врачи разводят на деньги")' },
            { label: 'Смешанная (без прицела)', value: 'mixed' },
          )),
    );
}

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
    embed.addFields({
      name: `${i + 1}. ${idea.topic}`.slice(0, 256),
      value: `${idea.format} · ${idea.source}\n💬 *Хук:* ${idea.hook}\n🎯 *Почему зайдёт:* ${idea.why || ''}`.slice(0, 1024),
    });
  }
  return embed;
}

// Каноническая форма для короткого ввода аудитории (из /ideas и из модалки).
function normalizeAudience(raw) {
  if (raw === null || raw === undefined) return 'проактивный ("хочу быть лучшей версией себя")';
  const v = raw.trim().toLowerCase();
  if (v === '' ) return 'проактивный ("хочу быть лучшей версией себя")';
  if (v === 'mixed' || v.startsWith('смеш')) return '';
  if (v.startsWith('тревож')) return 'тревожный пациент ("боюсь, что что-то не так")';
  if (v.startsWith('проактив')) return 'проактивный ("хочу быть лучшей версией себя")';
  if (v.startsWith('скептик')) return 'скептик ("врачи разводят на деньги")';
  return raw.trim();
}

// ── Общая логика /ideas — используется и слэш-командой, и кнопкой+модалкой ──
async function runIdeasGeneration(interaction, { count, focus, format, audience, userName }) {
  await interaction.editReply(`⏳ Генерирую ${count} идей${focus ? ` по теме «${focus}»` : ''}...`);
  console.log(`[ideas] старт: user=${userName} count=${count} focus="${focus}" format="${format}" audience="${audience}"`);

  const profile = await getDoctorProfile();
  console.log('[ideas] профиль получен');
  const ideas = await generateIdeas({ count, focus, format, audience, profile, userName });
  console.log(`[ideas] сгенерировано идей: ${ideas.length}`);

  for (const idea of ideas) {
    try { await saveIdea(idea, profile.name); }
    catch (e) { console.error('Notion saveIdea error:', e.message); }
  }
  console.log('[ideas] идеи сохранены в Notion');

  const notionUrl = await getIdeasDbUrl();
  const embed = ideasToEmbed(ideas, profile.name);

  await safeRespond(interaction, {
    content: `Готово! 📋 [Открыть все идеи в Notion](${notionUrl})`,
    embeds: [embed],
  });
}

// ── Общая логика /develop — используется и слэш-командой, и кнопкой ────────
async function runDevelop(interaction) {
  await interaction.editReply('⏳ Ищу идеи в статусе "✅ В работу"...');
  console.log('[develop] старт');

  const res = await withTimeout(notion.databases.query({
    database_id: process.env.NOTION_IDEAS_DB_ID,
    filter: { property: 'Статус', select: { equals: '✅ В работу' } },
  }), 20000, 'Notion develop query');

  if (res.results.length === 0) {
    await safeRespond(interaction, { content: 'Нет идей в статусе "✅ В работу".' });
    return;
  }

  const profile = await getDoctorProfile();
  let done = 0;
  const errors = [];
  for (const page of res.results) {
    const props = page.properties;
    const idea = {
      topic: plainText(props['Тема']?.title),
      format: props['Формат']?.select?.name || '',
      hook: plainText(props['Хук']?.rich_text),
      why: plainText(props['Почему зайдёт']?.rich_text),
    };
    try {
      await interaction.editReply(`⏳ Пишу сценарий ${done + 1}/${res.results.length}: «${idea.topic.slice(0, 60)}»...`);
      const styles = await generateScripts(idea, profile);
      await saveScriptsToPage(page.id, styles);
      await withTimeout(
        notion.pages.update({ page_id: page.id, properties: { 'Статус': { select: { name: '🎬 В конвейере' } } } }),
        20000, 'Notion develop status update',
      );
      done++;
      console.log(`[develop] сценарий готов: ${page.id}`);
    } catch (e) {
      console.error('[develop] ошибка на идее', page.id, e.stack || e.message);
      errors.push(`«${idea.topic.slice(0, 60)}»: ${e.message}`);
    }
  }

  const errorSummary = errors.length ? `\n\n⚠️ Ошибки:\n${errors.map(m => `• ${m}`).join('\n')}`.slice(0, 1500) : '';
  await safeRespond(interaction, {
    content: `Готово! ✍️ Сценарии написаны для ${done}/${res.results.length} идей. Статус изменён на "🎬 В конвейере".${errorSummary}`,
  });
}

client.on('interactionCreate', async (interaction) => {
  try {
    // ── /ideas ──────────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'ideas') {
      const count = interaction.options.getInteger('count', true);
      const focus = interaction.options.getString('focus') || '';
      const format = interaction.options.getString('format') || '';
      const audienceRaw = interaction.options.getString('audience');
      const audience = audienceRaw === 'mixed' ? '' : normalizeAudience(audienceRaw);
      const userName = interaction.user.username;

      await interaction.deferReply();
      await runIdeasGeneration(interaction, { count, focus, format, audience, userName });
      return;
    }

    // ── /develop ────────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'develop') {
      await interaction.deferReply();
      await runDevelop(interaction);
      return;
    }

    // ── /panel — публикует и закрепляет кнопки запуска в текущем канале ─────
    if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
      await interaction.reply({
        content: '**Запуск бота**\nНажми кнопку, чтобы сгенерировать идеи или написать сценарии — без слэш-команд.',
        components: [buildLauncherRow()],
      });
      try {
        const msg = await interaction.fetchReply();
        await msg.pin();
      } catch (e) {
        console.error('[/panel] не удалось закрепить сообщение:', e.message);
      }
      return;
    }

    // ── Кнопка «Сгенерировать идеи» — открывает форму ────────────────────────
    if (interaction.isButton() && interaction.customId === 'launch_ideas') {
      await interaction.showModal(buildIdeasModal());
      return;
    }

    // ── Кнопка «Написать сценарии» — запускает /develop сразу ───────────────
    if (interaction.isButton() && interaction.customId === 'launch_develop') {
      await interaction.deferReply();
      await runDevelop(interaction);
      return;
    }

    // ── Сабмит формы генерации идей ──────────────────────────────────────────
    if (interaction.isModalSubmit() && interaction.customId === 'ideas_modal') {
      const countRaw = parseInt(interaction.fields.getTextInputValue('count'), 10);
      const count = Number.isFinite(countRaw) ? Math.min(10, Math.max(1, countRaw)) : 5;
      const focus = interaction.fields.getTextInputValue('focus') || '';
      const format = interaction.fields.getStringSelectValues('format')[0] || '';
      const audienceRaw = interaction.fields.getStringSelectValues('audience')[0] || null;
      const audience = audienceRaw === 'mixed' ? '' : normalizeAudience(audienceRaw);
      const userName = interaction.user.username;

      await interaction.deferReply();
      await runIdeasGeneration(interaction, { count, focus, format, audience, userName });
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
      setInterval(cleanupRejectedIdeas, 60000);
    });
  } catch (err) {
    console.error('❌ Не удалось запустить бота:', err.message);
    process.exit(1);
  }
})();
