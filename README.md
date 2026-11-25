# Мой планер

Личный планер: Telegram-бот @ownlifeali_bot + сайт.

- `public/index.html` — сайт (Cloudflare Worker `my-planner`, деплоится сам при пуше в `main`)
- `supabase/functions/planner/index.ts` — бот, напоминания, ИИ и API для сайта (Supabase Edge Function, проект friends-quiz-bot, схема `life`)

Секреты (в Supabase → Edge Functions → Secrets, не в репозитории):
`PLANNER_BOT_TOKEN`, `OPENAI_API_KEY` или `ANTHROPIC_API_KEY`.
