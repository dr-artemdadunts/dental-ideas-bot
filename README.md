# Dental Ideas Bot

Slack-бот для генерации контент-идей стоматологов с сохранением в Notion.

## Команды

- `/ideas` — открывает модалку для генерации идей (выбор кол-ва + фокус недели)
- `/profile` — заполнить свой профиль голоса и специализации

## Настройка

### 1. Slack App

1. Зайди на [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → From scratch
2. **OAuth & Permissions** → Bot Token Scopes: `chat:write`, `commands`, `views:open`
3. **Slash Commands** → создай две команды:
   - `/ideas` — Request URL: `https://ТВОЙ-RAILWAY-URL/slack/events`
   - `/profile` — Request URL: `https://ТВОЙ-RAILWAY-URL/slack/events`
4. **Event Subscriptions** → Enable → Request URL: `https://ТВОЙ-RAILWAY-URL/slack/events`
5. **Install App** → установи в workspace → скопируй Bot Token (`xoxb-...`)
6. **Basic Information** → Signing Secret — скопируй

### 2. Notion Integration

1. Зайди на [notion.so/my-integrations](https://www.notion.so/my-integrations) → **New integration**
2. Название: `dental-ideas-bot`, Workspace: `3dent`
3. Скопируй **Internal Integration Token**
4. Открой страницу **Фабрика идей** в Notion
5. Нажми `...` → **Add connections** → выбери свою интеграцию
6. Сделай то же для баз **Банк идей** и **Профили врачей**

### 3. Деплой на Railway

1. Запушь репо на GitHub
2. Railway → **New Project** → **Deploy from GitHub** → выбери `dental-ideas-bot`
3. **Variables** → добавь все переменные из `.env.example`:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
ANTHROPIC_API_KEY=sk-ant-...
NOTION_TOKEN=secret_...
NOTION_IDEAS_DB_ID=bc7c9d5a4cb34122b9370e6ab2187c07
NOTION_PROFILES_DB_ID=3ba725bdab514149a6321f8bffde54e9
PORT=3000
```

4. После деплоя скопируй URL сервиса и вставь в Slack App (шаг 1.3 и 1.4)

## Переменные окружения

| Переменная | Описание |
|---|---|
| `SLACK_BOT_TOKEN` | Bot token из Slack App |
| `SLACK_SIGNING_SECRET` | Signing Secret из Slack App |
| `ANTHROPIC_API_KEY` | API ключ Anthropic |
| `NOTION_TOKEN` | Internal Integration Token из Notion |
| `NOTION_IDEAS_DB_ID` | ID базы "Банк идей" |
| `NOTION_PROFILES_DB_ID` | ID базы "Профили врачей" |
