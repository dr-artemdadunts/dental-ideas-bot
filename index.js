require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require('@notionhq/client');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  customRoutes: [
    {
      path: '/ping',
      method: ['GET'],
      handler: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      },
    },
  ],
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const notion = new Client({ auth: process.env.NOTION_TOKEN });

// ── Notion helpers ────────────────────────────────────────────────────────────

async function getProfile(slackId) {
  try {
    const res = await notion.databases.query({
      database_id: process.env.NOTION_PROFILES_DB_ID,
      filter: { property: 'Slack ID', rich_text: { equals: slackId } },
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

async function upsertProfile(slackId, userName, fields) {
  const existing = await getProfile(slackId);
  const props = {
    'Имя': { title: [{ text: { content: fields.name || userName } }] },
    'Slack ID': { rich_text: [{ text: { content: slackId } }] },
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
  let response = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 4000, tools, messages });

  while (response.stop_reason === 'tool_use') {
    const toolUse = response.content.find(b => b.type === 'tool_use');
    let toolResult = '';
    if (toolUse.name === 'web_search') {
      try { toolResult = await tavilySearch(toolUse.input.query); }
      catch (e) { toolResult = 'Поиск недоступен: ' + e.message; }
    }
    messages = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: toolResult }] },
    ];
    response = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 4000, tools, messages });
  }

  const text = response.content.find(b => b.type === 'text')?.text || '[]';
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error('JSON parse error, retrying');
    messages = [...messages, { role: 'assistant', content: response.content }, { role: 'user', content: 'Верни ТОЛЬКО JSON массив без пояснений и markdown.' }];
    const retry = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 4000, messages });
    return JSON.parse(retry.content.find(b => b.type === 'text')?.text || '[]');
  }
}

// ── /ideas ────────────────────────────────────────────────────────────────────

app.command('/ideas', async ({ command, ack, client }) => {
  console.log('[/ideas] received, trigger_id:', command.trigger_id?.slice(0, 20));
  await ack();
  console.log('[/ideas] ack sent');
  try {
    await client.views.open({
      trigger_id: command.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'ideas_modal',
        private_metadata: JSON.stringify({ channel: command.channel_id, user_id: command.user_id, user_name: command.user_name }),
        title: { type: 'plain_text', text: '💡 Генерация идей' },
        submit: { type: 'plain_text', text: 'Сгенерировать' },
        close: { type: 'plain_text', text: 'Отмена' },
        blocks: [
          {
            type: 'input',
            block_id: 'count_block',
            label: { type: 'plain_text', text: 'Количество идей' },
            element: {
              type: 'static_select',
              action_id: 'count',
              placeholder: { type: 'plain_text', text: 'Выбери количество' },
              options: [
                { text: { type: 'plain_text', text: '5 идей' }, value: '5' },
                { text: { type: 'plain_text', text: '8 идей' }, value: '8' },
                { text: { type: 'plain_text', text: '12 идей' }, value: '12' },
              ],
            },
          },
          {
            type: 'input',
            block_id: 'focus_block',
            optional: true,
            label: { type: 'plain_text', text: 'Фокус недели (необязательно)' },
            element: {
              type: 'plain_text_input',
              action_id: 'focus',
              placeholder: { type: 'plain_text', text: 'Например: профилактика кариеса у взрослых' },
              multiline: false,
            },
          },
        ],
      },
    });
    console.log('[/ideas] modal opened');
  } catch (err) {
    console.error('[/ideas] error:', err.message, JSON.stringify(err.data));
  }
});

app.view('ideas_modal', async ({ ack, view, client }) => {
  await ack();
  const meta = JSON.parse(view.private_metadata);
  const { channel, user_id, user_name } = meta;
  const count = parseInt(view.state.values.count_block.count.selected_option.value, 10);
  const focus = view.state.values.focus_block.focus.value || '';

  await client.chat.postMessage({ channel, text: `⏳ Генерирую ${count} идей${focus ? ` по теме «${focus}»` : ''}...` });

  try {
    const profile = await getProfile(user_id);
    const defaultProfile = profile || { name: user_name, specialization: '🦷 Терапия, 🪥 Гигиена' };
    const ideas = await generateIdeas({ count, focus, profile: defaultProfile, userName: user_name });

    for (const idea of ideas) {
      try { await saveIdea(idea, defaultProfile.name || user_name); }
      catch (e) { console.error('Notion saveIdea error:', e.message); }
    }

    const notionUrl = `https://www.notion.so/${process.env.NOTION_IDEAS_DB_ID.replace(/-/g, '')}`;

    const ideaBlocks = ideas.flatMap((idea, i) => [
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${i + 1}. ${idea.topic}*\n${idea.format} · ${idea.source}\n\n💬 *Хук:* ${idea.hook}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `📋 *Сценарий:*\n${(idea.script || idea.why || '').slice(0, 700)}`,
        },
      },
    ]);

    await client.chat.postMessage({
      channel,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `✅ *${ideas.length} идей для ${defaultProfile.name || user_name}*` } },
        ...ideaBlocks,
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: `<${notionUrl}|📋 Открыть все идеи в Notion>` } },
      ],
      text: `Готово! ${ideas.length} идей сгенерировано.`,
    });
  } catch (err) {
    console.error('ideas_modal error:', err);
    await client.chat.postMessage({ channel, text: `❌ Ошибка: ${err.message}` });
  }
});

// ── /profile ──────────────────────────────────────────────────────────────────

app.command('/profile', async ({ command, ack, client }) => {
  await ack();
  const existing = await getProfile(command.user_id);
  try {
    await client.views.open({
      trigger_id: command.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'profile_modal',
        private_metadata: JSON.stringify({ user_id: command.user_id, user_name: command.user_name, channel: command.channel_id }),
        title: { type: 'plain_text', text: '👤 Мой профиль' },
        submit: { type: 'plain_text', text: 'Сохранить' },
        close: { type: 'plain_text', text: 'Отмена' },
        blocks: [
          {
            type: 'input',
            block_id: 'spec_block',
            label: { type: 'plain_text', text: 'Специализация' },
            element: {
              type: 'checkboxes',
              action_id: 'specialization',
              initial_options: existing?.specialization
                ? existing.specialization.split(', ').map(s => ({ text: { type: 'plain_text', text: s }, value: s }))
                    .filter(o => ['🦷 Терапия', '🪥 Гигиена', '🦴 Ортопедия', '🔬 Пародонтология', '😁 Эстетика'].includes(o.value))
                : undefined,
              options: [
                { text: { type: 'plain_text', text: '🦷 Терапия' }, value: '🦷 Терапия' },
                { text: { type: 'plain_text', text: '🪥 Гигиена' }, value: '🪥 Гигиена' },
                { text: { type: 'plain_text', text: '🦴 Ортопедия' }, value: '🦴 Ортопедия' },
                { text: { type: 'plain_text', text: '🔬 Пародонтология' }, value: '🔬 Пародонтология' },
                { text: { type: 'plain_text', text: '😁 Эстетика' }, value: '😁 Эстетика' },
              ],
            },
          },
          {
            type: 'input', block_id: 'voice_block', optional: true,
            label: { type: 'plain_text', text: 'Как я говорю' },
            element: { type: 'plain_text_input', action_id: 'voice', initial_value: existing?.voice || '', placeholder: { type: 'plain_text', text: 'Просто, без сложных терминов' }, multiline: true },
          },
          {
            type: 'input', block_id: 'avoid_block', optional: true,
            label: { type: 'plain_text', text: 'Чего избегаю' },
            element: { type: 'plain_text_input', action_id: 'avoid', initial_value: existing?.avoid || '', placeholder: { type: 'plain_text', text: 'Пугать пациентов' }, multiline: true },
          },
          {
            type: 'input', block_id: 'works_block', optional: true,
            label: { type: 'plain_text', text: 'Что заходит у аудитории' },
            element: { type: 'plain_text_input', action_id: 'works', initial_value: existing?.works || '', placeholder: { type: 'plain_text', text: 'До/после, развенчание мифов' }, multiline: true },
          },
          {
            type: 'input', block_id: 'notoncamera_block', optional: true,
            label: { type: 'plain_text', text: 'Не делаю в кадре' },
            element: { type: 'plain_text_input', action_id: 'notOnCamera', initial_value: existing?.notOnCamera || '', placeholder: { type: 'plain_text', text: 'Танцы, тренды с музыкой' }, multiline: true },
          },
        ],
      },
    });
  } catch (err) {
    console.error('[/profile] error:', err.message);
  }
});

app.view('profile_modal', async ({ ack, view, client }) => {
  await ack();
  const meta = JSON.parse(view.private_metadata);
  const { user_id, user_name, channel } = meta;
  const vals = view.state.values;
  const specialization = (vals.spec_block.specialization.selected_options || []).map(o => o.value);

  try {
    await upsertProfile(user_id, user_name, {
      specialization,
      voice: vals.voice_block.voice.value || '',
      avoid: vals.avoid_block.avoid.value || '',
      works: vals.works_block.works.value || '',
      notOnCamera: vals.notoncamera_block.notOnCamera.value || '',
    });
    await client.chat.postMessage({ channel, text: `✅ Профиль обновлён, <@${user_id}>!` });
  } catch (err) {
    console.error('profile_modal error:', err);
    await client.chat.postMessage({ channel, text: `❌ Ошибка: ${err.message}` });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`Бот запущен на порту ${port}`);
})();
