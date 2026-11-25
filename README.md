# King Cajun WhatsApp Bot

The WhatsApp ordering application for King Cajun in Medellín, Colombia. This public source snapshot includes the bot, shared restaurant back-office modules, and tests, as of November 24, 2026.

The original working repository remains private because it contains operational history. This repository has a new, source-only history. It is not automatically connected to the restaurant's production deployment.

## Features

- WhatsApp Cloud API and 360dialog adapters, with a simulated provider for local use.
- Spanish conversational ordering, menu images, human handoff, and optional AI-assisted cart interpretation.
- Scheduled pickup and delivery, neighborhood grouping, driver availability, and capacity limits.
- Payment instructions, staff verification, and an optional Gmail bank-notification integration.
- Shared PostgreSQL/PGlite persistence, kitchen tickets, table ordering, and private invitation reservations.
- Onto models for restaurant and delivery workflows.

## Local setup

Requires Node.js 24 or newer and npm.

```sh
git clone https://github.com/camiinthisthang/kingcajun-bot.git
cd kingcajun-bot
npm ci
cp .env.example .env
npm run db:seed
npm run dev
```

The example starts with `BOT_MODE=standby`, `WHATSAPP_PROVIDER=demo`, a local PGlite database, and no production credentials. For local conversation testing, set `BOT_MODE=ordering` in `.env` and open http://localhost:3000/demo. No real WhatsApp messages are sent by the demo provider. Seeding is blocked in production.

```sh
npm run build
npm test
```

Historical dates, menus, and capacity policies in this snapshot are implementation examples, not current restaurant availability. Some older provider/prelaunch tests have failing expectations against the current application; see `VALIDATION.md` for the measured result.

## Configuration and private data

Copy `.env.example` and configure your own provider, database, payment, admin, and optional AI credentials. The optional bank-mail OAuth integration uses `BANK_MAIL_EMAIL` instead of a personal address. Bank account suffixes and payment keys in the public parser, messaging examples, and tests are **dummy zeros**; adapt them to your own setup before enabling payment checks. Supply your own `PAYMENT_QR_IMAGE_URL`.

No `.env` files, live databases, customer lists, delivery-route exports, real bank QR, payment screenshots, access documents, or private Git history are published. Hosted rehearsal modes (`PHONE_PREVIEW` and `LIVE_TEST_PHONE`) require your own reviewed seed files; internal catalog exports are deliberately excluded. They are not needed for normal local development.

`src/` is the bot application; `admin-dashboard/src/` contains shared kitchen, delivery, payment and workflow modules. Static interface assets are in `admin-dashboard/public/`. The original deployment Dockerfile is provided, but deploying this repository does not provision credentials, databases, provider templates, current menus, or staff accounts.

## Dependencies and branding

The included official `@trigramco/ontolang` artifact is pinned to [trigramco/onto commit 52b59c01d2069fa6a2f9a14b0ab674cabbbf6ea1](https://github.com/trigramco/onto/tree/52b59c01d2069fa6a2f9a14b0ab674cabbbf6ea1). Third-party notices remain in their packages and asset directories. Public visibility does not grant rights to King Cajun trademarks or artwork. No additional software license is granted by this publication.
