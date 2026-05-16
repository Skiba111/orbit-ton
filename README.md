# ORBIT — Recurring Payments on TON

ORBIT — модульная библиотека смарт-контрактов для подписочного биллинга на блокчейне TON. Позволяет любому сервису принимать регулярные платежи в TON или Jetton-токенах без необходимости строить биллинговую инфраструктуру с нуля.

```
Subscriber ──► Factory ──► Subscription ──► Service
                                │
                                └──► FeeCollector (protocol fee)
```

> **Статус (май 2026):** контракты задеплоены на testnet, E2E-тест пройден — 6 успешных списаний подтверждены через webhook. Mainnet-деплой — следующий шаг.

---

## Содержание

- [Возможности](#возможности)
- [Архитектура](#архитектура)
- [Быстрый старт](#быстрый-старт)
- [Деплой](#деплой)
- [Интеграция бэкенда](#интеграция-бэкенда)
- [Сборка и тесты](#сборка-и-тесты)
- [Адреса testnet](#адреса-testnet)
- [Структура репозитория](#структура-репозитория)
- [Комиссии](#комиссии)
- [Безопасность](#безопасность)
- [Лицензия](#лицензия)

---

## Возможности

- **TON и Jetton-биллинг** — нативная монета или любой TEP-74 токен
- **Депозитная модель** — подписчик пополняет баланс заранее; нет pull-платежей
- **Keeper-сеть** — любой желающий может триггерить списания и получать вознаграждение
- **Грейс-период + ретрай** — 3 дня до отмены при нехватке средств
- **Подписки с фиксированным сроком** — опциональный лимит `max_periods` с автоотменой
- **Смена тарифа** — подписчик запрашивает переход; фабрика маршрутизирует безопасно
- **Timelock-вывод комиссий** — 24-часовая задержка на вывод протокольной комиссии
- **Полная проверяемость** — все денежные потоки детерминированы и верифицируемы on-chain

---

## Архитектура

| Контракт | Назначение |
|---|---|
| `Registry` | Точка входа для сервис-разработчиков; деплоит Factory с enforced-комиссиями ORBIT |
| `Factory` | Деплоит Subscription-контракты; хранит реестр тарифов; маршрутизирует смену тарифов |
| `Subscription` | Биллинговое состояние одного пользователя; хранит депозит подписчика |
| `FeeCollector` | Накапливает протокольные комиссии; двухфазный вывод с timelock'ом |

### Поток платежа

```
Подписчик пополняет Subscription (при подписке)
     │
     ▼  каждый period секунд — trigg от relayer/keeper
Subscription.OP_CHARGE_EXT  ←── внешнее сообщение с Ed25519-подписью
     │
     ├── protocol_fee (0.2%, вшита в байткод) ──► FeeCollector
     ├── service_fee  (fee_bps, задаётся при деплое Factory) ──► fee_collector
     └── net_amount ──────────────────────────────────────────► Service
```

---

## Быстрый старт

### 1. Клонирование и установка зависимостей

```bash
git clone https://github.com/Skiba111/orbit-ton.git
cd orbit-ton
npm install
```

### 2. Настройка .env

Создайте файл `.env` в корне репозитория:

```env
# .env — НИКОГДА не коммитьте этот файл (он в .gitignore)

# --- Деплой ---
WALLET_MNEMONIC="слово1 слово2 ... слово24"   # кошелёк для оплаты деплоя
FEE_COLLECTOR_PUBKEY="abcdef1234..."           # hex Ed25519 pubkey для fee-collector ключа
TONCENTER_API_KEY="ваш_ключ"                  # необязательно, повышает лимиты
NETWORK=testnet                                # testnet | mainnet
WALLET_VERSION=v5                              # v4 | v5 (v5 = Tonkeeper)

# --- Relayer (на сервере) ---
FACTORY_ADDRESS="EQD..."                       # адрес задеплоенной Factory
RELAYER_MNEMONIC="слово1 слово2 ... слово24"  # отдельный ключ для relayer
POLL_INTERVAL_MS=60000                         # интервал опроса, мс
WEBHOOK_URL=https://yourapp.com/orbit/webhook  # URL для уведомлений о списаниях
WEBHOOK_SECRET=длинная-случайная-строка        # общий секрет с webhook-сервером
```

### 3. Компиляция и тесты

```bash
npm test   # запускает все тесты (Blueprint sandbox)
```

### 4. Интеграция через Registry (для сервис-разработчиков)

Если ORBIT Registry уже задеплоен, вам не нужно деплоить Factory вручную:

```bash
# .env: добавьте REGISTRY_ADDRESS=EQD... (адрес ORBIT Registry)
ts-node scripts/register-service.ts
# → Отправляет 0.3 TON на Registry
# → Registry деплоит Factory с вашим кошельком как service_addr
# → Выводит адрес вашей Factory — скопируйте в FACTORY_ADDRESS
```

### 4а. Ручной деплой Factory (для ORBIT-оператора)

```bash
ts-node scripts/deploy-standalone.ts
```

Скрипт интерактивно запросит параметры Factory и задеплоит FeeCollector + Factory. На выходе — адреса обоих контрактов.

### 5. E2E тест (проверка полного цикла)

```bash
ts-node scripts/test-e2e.ts
```

Деплоит тестовую Factory с period=120s, отправляет подписку, проверяет webhook.

---

## Деплой

Полный гайд: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**

Краткая схема:
1. Сгенерировать два Ed25519 ключа: один для relayer (hot), один для fee-collector (cold)
2. Задеплоить через `ts-node scripts/deploy-standalone.ts`
3. Запустить relayer и webhook-сервер через PM2 на VPS

---

## Интеграция бэкенда

### Отправка подписки (frontend → Factory)

```typescript
import { beginCell, toNano } from "@ton/core";

// Тело сообщения: op(32) + query_id(64) + plan_id(32) + payment_type(2)
// PAYMENT_TON = 1,  PAYMENT_JETTON = 2,  0 — НЕВАЛИДНО
const body = beginCell()
    .storeUint(0x4F520001, 32)  // OP_SUBSCRIBE
    .storeUint(0,           64)  // query_id (можно 0)
    .storeUint(0,           32)  // plan_id = 0 (первый тариф)
    .storeUint(1,            2)  // payment_type = TON
    .endCell();

// value = plan_price + 0.1 TON минимум (gas + storage reserve)
// Рекомендуем: plan_price + 0.2 TON
await tonconnect.sendTransaction({
    messages: [{
        address: FACTORY_ADDRESS,
        amount:  String(toNano("0.4")),   // для тарифа 0.2 TON
        payload: body.toBoc().toString("base64"),
    }],
});
```

### Webhook — получение событий списания

После каждого подтверждённого списания relayer шлёт POST на `WEBHOOK_URL`:

```json
{
  "event":      "charge_confirmed",
  "address":    "EQAem3BPC7PvJzPGItrwNDVizMSqFIZ0nUDZvebfB4NBDn5w",
  "seqno_from": 0,
  "seqno_to":   1,
  "timestamp":  1747374000
}
```

`address` — адрес Subscription-контракта подписчика. Используйте его для выдачи доступа в вашей системе.

Готовый пример webhook-сервера: [`scripts/webhook-server.ts`](scripts/webhook-server.ts)

### Проверка статуса подписки (on-chain)

```typescript
import { TonClient, Address } from "@ton/ton";
import { Subscription }       from "./wrappers/Subscription";

const client = new TonClient({
    endpoint: "https://testnet.toncenter.com/api/v2/jsonRPC",
    apiKey:   process.env.TONCENTER_API_KEY,
});

const sub = client.open(
    Subscription.createFromAddress(Address.parse("EQD...адрес_подписки..."))
);

const status  = await sub.getStatus();           // 1=TRIAL 2=ACTIVE 3=PAUSED 4=GRACE 5=CANCELLED
const seqno   = await sub.getSeqno();            // количество успешных списаний
const billing = await sub.getNextBillingTime();  // unix timestamp следующего списания
```

Подробнее: **[docs/INTEGRATION.md](docs/INTEGRATION.md)**

---

## Сборка и тесты

```bash
npm install
npm test                       # unit + integration тесты (Blueprint sandbox)
ts-node scripts/test-e2e.ts    # E2E на testnet (требует .env с реальными ключами)
```

---

## Адреса testnet

| Контракт | Адрес |
|---|---|
| FeeCollector | `EQDDU30Vfvjf4wVgyw5Mzh3aMmcvP7Y0sFb2zQ-2tTNbadze` |
| Factory (production: 1 TON/мес + 5 TON/мес) | `EQADc2gC0KFW-vNPeHJ18EFG81YMBWwR6qQsbSSaWCUmQuJ2` |
| Factory (E2E тест: 0.2 TON / 2 мин) | `EQDYJOcdv9C_Uf3tNqCvgPuAQT-hVxLdOEfJePtSiR_YjVCS` |
| Relayer pubkey | `52dfadb8e95cfce76eb724f79758ad9c06117913f3a080f7f749d130216338a8` |

> Mainnet-адреса будут опубликованы после mainnet-деплоя.

---

## Структура репозитория

```
contracts/              Tolk-контракты: Subscription, Factory, FeeCollector
billing/                Движок списания, роутер комиссий, планировщик ретраев
payment/                Адаптеры платежей: TON и Jetton
plans/                  Реестр тарифов и логика trial-периода
core/                   Схема хранения, арифметика периодов, состояние подписки
access/                 Менеджер ролей, аварийная пауза
utils/                  Коды ошибок, опкоды, математика, oracle времени
wrappers/               TypeScript-обёртки для Blueprint/sandbox-тестов
tests/                  Тесты безопасности и интеграции
scripts/
  deploy-standalone.ts  Деплой FeeCollector + Factory (без Blueprint, через TonCenter REST)
  relayer.ts            Charge-relayer: WAL, exponential backoff, webhook, keeper-mode
  webhook-server.ts     Пример webhook-получателя для вашего бэкенда
  test-e2e.ts           E2E тест: деплой тестовой Factory → подписка → списание → webhook
  patch-ton-core.ts     Полифил domainSign для @ton/core@0.56.x + @ton/ton@16
sdk/react/              @orbit-ton/react — React hooks и компоненты (в разработке, не опубликован)
docs/                   Документация разработчика
```

---

## Комиссии

Каждый биллинговый цикл вычитает **две комиссии** из суммы тарифа перед отправкой сервису:

| Комиссия | Кто устанавливает | Куда идёт | Значение |
|-----|------------|---------------|----------|
| **Service fee** | Оператор Factory (`fee_bps`) | `fee_collector` фабрики | 0 – 10% (configurable) |
| **Protocol fee** | Вшита в байткод (`PROTOCOL_FEE_BPS = 20`) | ORBIT `protocol_fee_collector` | 0.2% (фиксировано) |

**Пример** — тариф 1 TON/месяц, service fee = 1% (100 bps):
- Gross: 1.000 TON
- Protocol fee (0.2%): 0.002 TON → ORBIT
- Service fee (1%): 0.010 TON → fee_collector
- **Сервис получает**: 0.988 TON

Протокольная комиссия вшита в байткод — её нельзя изменить без перекомпиляции, что даст другой hash байткода.

Подробнее: [docs/PROTOCOL_FEE.md](docs/PROTOCOL_FEE.md)

---

## Безопасность

| Защита | Механизм |
|---|---|
| Replay-атаки | seqno + timestamp window (60s) на внешних сообщениях |
| Двойное списание | флаг `charging_in_progress` для Jetton; `next_billing_time` для TON |
| Истощение storage | `raw_reserve(storage_reserve, 0)` перед каждым send |
| Bounce восстановление | депозит возвращается если платёжное сообщение отбито |
| Компрометация ключа | 24-часовой timelock на вывод из FeeCollector |
| Подмена подписки | Factory хранит sub_addr в `subscriber_info` — адрес не берётся от caller'а |

Подробнее: [docs/SECURITY.md](docs/SECURITY.md)

---

## Лицензия

Business Source License 1.1 — бесплатно для некоммерческого использования.
Переходит в MIT 2029-05-15.
Коммерческое лицензирование: skibatima9@gmail.com
