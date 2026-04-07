require('dotenv').config();
const express = require('express');
const { App, ExpressReceiver } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require('@notionhq/client');

// ── Express + Bolt setup ─────────────────────────────────────────────────────

const expressApp = express();

expressApp.use('/slack/events', express.raw({ type: '*/*' }), (req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} /slack/events content-type:`, req.headers['content-type']);
  const raw = req.body;
  req.rawBody = raw;
  const contentType = req.headers['content-type'] || '';

  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw.toString());
      req.body = parsed;
      if (parsed.type === 'url_verification') return res.json({ challenge: parsed.challenge });
    } catch (e) {}
  } else if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw.toString());
    req.body = Object.fromEntries(params.entries());
  }

  next();
});

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  signatureVerification: false,
  app: expressApp,
});

const app = new App({ token: process.env.SLACK_BOT_TOKEN, receiver });
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
  await notion.pages.create({
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
  });
}

// ── Claude ────────────────────────────────────────────────────────────────────

const tools = [
  {
    name: 'web_search',
    description: 'Search the internet for current dental trends, patient questions, and content ideas. Use for finding trending topics, recent studies, or competitor content.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query in Russian or English' } },
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
  const spec = profile?.specialization || 'Терапия, Гигиена';
  const voiceInfo = profile ? `
Как говорит: ${profile.voice || 'не указано'}
Чего избегает: ${profile.avoid || 'не указано'}
Что заходит: ${profile.works || 'не указано'}
Не делает в кадре: ${profile.notOnCamera || 'не указано'}` : '';

  const prompt = `Ты контент-стратег для стоматолога в СНГ. Сгенерируй ровно ${count} идей для соцсетей.

Врач: ${profile?.name || userName}
Специализация: ${spec}${voiceInfo}
${focus ? `Фокус недели: ${focus}` : ''}

СТРОГИЕ ПРАВИЛА:
- Только темы по специализации врача (${spec})
- Только СНГ-аудитория, реалии СНГ
- БЕЗ хирургии, ортодонтии, педиатрии (если не в специализации)
- БЕЗ тем про цены и стоимость лечения
- БЕЗ американских трендов и исследований
- Источник выбирай из: "💬 Вопрос пациента", "🔥 Тренд", "🕵️ Конкурент", "🔬 PubMed", "💡 Своя идея"
- Формат выбирай из: "🎬 Reels 30 сек", "🎬 Reels 60 сек", "🎠 Карусель", "📝 Пост", "🔬 Научная ветка"

Используй web_search для поиска актуальных трендов и вопросов пациентов перед генерацией.

Верни ТОЛЬКО валидный JSON массив без markdown блоков:
[{"topic":"...","format":"...","source":"...","hook":"...","why":"..."}]`;

  let messages = [{ role: 'user', content: prompt }];
  let response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    tools,
    messages,
  });

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
    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      tools,
      messages,
    });
  }

  const text = response.content.find(b => b.type === 'text')?.text || '[]';
  try {
    return JSON.parse(text);
  } catch (e) {
    // Повтор при невалидном JSON
    console.error('JSON parse error, retrying:', text.slice(0, 200));
    messages = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: 'Ответ не является валидным JSON. Верни ТОЛЬКО JSON массив, без пояснений и markdown.' },
    ];
    const retry = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages,
    });
    return JSON.parse(retry.content.find(b => b.type === 'text')?.text || '[]');
  }
}

// ── /ideas command ────────────────────────────────────────────────────────────

app.command('/ideas', async ({ command, ack, client }) => {
  await ack();
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
});

app.view('ideas_modal', async ({ ack, view, client }) => {
  await ack();

  const meta = JSON.parse(view.private_metadata);
  const { channel, user_id, user_name } = meta;
  const count = parseInt(view.state.values.count_block.count.selected_option.value, 10);
  const focus = view.state.values.focus_block.focus.value || '';

  // Ответить в канале "генерирую..."
  await client.chat.postMessage({
    channel,
    text: `⏳ Генерирую ${count} идей${focus ? ` по теме «${focus}»` : ''}...`,
  });

  try {
    const profile = await getProfile(user_id);
    const defaultProfile = profile || { name: user_name, specialization: 'Терапия, Гигиена' };

    const ideas = await generateIdeas({ count, focus, profile: defaultProfile, userName: user_name });

    // Сохранить в Notion
    for (const idea of ideas) {
      try { await saveIdea(idea, defaultProfile.name || user_name); }
      catch (e) { console.error('Notion saveIdea error:', e.message); }
    }

    // Сформировать ответ
    const notionUrl = `https://www.notion.so/${process.env.NOTION_IDEAS_DB_ID.replace(/-/g, '')}`;
    const lines = ideas.map((idea, i) =>
      `*${i + 1}. ${idea.topic}*\n${idea.format} · ${idea.source}\n_${idea.hook}_`
    ).join('\n\n');

    await client.chat.postMessage({
      channel,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `✅ Готово! ${ideas.length} идей для *${defaultProfile.name || user_name}*:\n\n${lines}` } },
        {
          type: 'actions',
          elements: [{
            type: 'button',
            text: { type: 'plain_text', text: '📋 Открыть в Notion' },
            url: notionUrl,
            style: 'primary',
          }],
        },
      ],
      text: `Готово! ${ideas.length} идей сгенерировано.`,
    });

  } catch (err) {
    console.error('ideas_modal error:', err);
    await client.chat.postMessage({
      channel,
      text: `❌ Ошибка при генерации: ${err.message}`,
    });
  }
});

// ── /profile command ──────────────────────────────────────────────────────────

app.command('/profile', async ({ command, ack, client }) => {
  await ack();

  const existing = await getProfile(command.user_id);

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
              ? existing.specialization.split(', ').map(s => ({ text: { type: 'plain_text', text: s }, value: s })).filter(o =>
                  ['🦷 Терапия', '🪥 Гигиена', '🦴 Ортопедия', '🔬 Пародонтология', '😁 Эстетика'].includes(o.value)
                )
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
          type: 'input',
          block_id: 'voice_block',
          optional: true,
          label: { type: 'plain_text', text: 'Как я говорю' },
          element: {
            type: 'plain_text_input',
            action_id: 'voice',
            initial_value: existing?.voice || '',
            placeholder: { type: 'plain_text', text: 'Просто, без сложных терминов, с примерами из жизни' },
            multiline: true,
          },
        },
        {
          type: 'input',
          block_id: 'avoid_block',
          optional: true,
          label: { type: 'plain_text', text: 'Чего избегаю' },
          element: {
            type: 'plain_text_input',
            action_id: 'avoid',
            initial_value: existing?.avoid || '',
            placeholder: { type: 'plain_text', text: 'Пугать пациентов, говорить про боль' },
            multiline: true,
          },
        },
        {
          type: 'input',
          block_id: 'works_block',
          optional: true,
          label: { type: 'plain_text', text: 'Что заходит у аудитории' },
          element: {
            type: 'plain_text_input',
            action_id: 'works',
            initial_value: existing?.works || '',
            placeholder: { type: 'plain_text', text: 'До/после, развенчание мифов, ответы на вопросы' },
            multiline: true,
          },
        },
        {
          type: 'input',
          block_id: 'notoncamera_block',
          optional: true,
          label: { type: 'plain_text', text: 'Не делаю в кадре' },
          element: {
            type: 'plain_text_input',
            action_id: 'notOnCamera',
            initial_value: existing?.notOnCamera || '',
            placeholder: { type: 'plain_text', text: 'Танцы, тренды с музыкой' },
            multiline: true,
          },
        },
      ],
    },
  });
});

app.view('profile_modal', async ({ ack, view, client }) => {
  await ack();

  const meta = JSON.parse(view.private_metadata);
  const { user_id, user_name, channel } = meta;
  const vals = view.state.values;

  const specialization = (vals.spec_block.specialization.selected_options || []).map(o => o.value);
  const voice = vals.voice_block.voice.value || '';
  const avoid = vals.avoid_block.avoid.value || '';
  const works = vals.works_block.works.value || '';
  const notOnCamera = vals.notoncamera_block.notOnCamera.value || '';

  try {
    await upsertProfile(user_id, user_name, { specialization, voice, avoid, works, notOnCamera });
    await client.chat.postMessage({
      channel,
      text: `✅ Профиль обновлён, <@${user_id}>!`,
    });
  } catch (err) {
    console.error('profile_modal error:', err);
    await client.chat.postMessage({
      channel,
      text: `❌ Ошибка при сохранении профиля: ${err.message}`,
    });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`Бот запущен на порту ${port}`);
})();
