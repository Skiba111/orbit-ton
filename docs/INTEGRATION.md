# Руководство по интеграции ORBIT

Добавьте подписочный биллинг ORBIT в своё приложение. Из документа вы узнаете как:
- Отправить подписку от имени пользователя
- Принимать webhook-события о списаниях
- Проверять статус подписки on-chain
- Обеспечить безопасность webhook-эндпоинта

---

## Требования

- Задеплоенная Factory (см. [DEPLOYMENT.md](DEPLOYMENT.md))
- Запущенный relayer (настраивается в DEPLOYMENT.md)
- Node.js 18+ на бэкенде

---

## 1. Формат сообщения OP_SUBSCRIBE

Чтобы подписчик оформил подписку, его кошелёк должен отправить сообщение на адрес вашей Factory.

### Формат тела сообщения

```
op          (32 бита) = 0x4F520001   — OP_SUBSCRIBE
query_id    (64 бита)               — произвольный идентификатор запроса (можно 0)
plan_id     (32 бита)               — ID тарифного плана (0, 1, 2, ...)
payment_type (2 бита)               — 1 = TON,  2 = Jetton  (0 — НЕВАЛИДНО!)
```

> **Критически важно:** Factory всегда читает `query_id` (64 бита) после `op`. Если пропустить `query_id` — сообщение отобьётся с ошибкой underflow. `PAYMENT_TON = 1` (не 0!).

### Пример на TypeScript

```typescript
import { beginCell, toNano } from "@ton/core";

// Тело для TON-подписки на тариф 0
const body = beginCell()
    .storeUint(0x4F520001, 32)  // OP_SUBSCRIBE
    .storeUint(0,           64)  // query_id (0 — допустимо)
    .storeUint(0,           32)  // plan_id = 0
    .storeUint(1,            2)  // payment_type = PAYMENT_TON (1)
    .endCell();

// value = plan_price + STORAGE_RESERVE(0.05 TON) + FACTORY_DEPLOY_GAS(0.05 TON) + запас
// Формула: value >= plan_price + 0.1 TON
// Рекомендуем: plan_price + 0.2 TON
const PLAN_PRICE = toNano("1"); // 1 TON/месяц
const value = PLAN_PRICE + toNano("0.2");
```

### Через TonConnect (frontend)

```typescript
import { useTonConnectUI } from "@tonconnect/ui-react";
import { beginCell, toNano } from "@ton/core";

function SubscribeButton({ planId, planPrice }: { planId: number; planPrice: bigint }) {
    const [tonConnectUI] = useTonConnectUI();

    async function handleSubscribe() {
        const body = beginCell()
            .storeUint(0x4F520001, 32)
            .storeUint(0,           64)
            .storeUint(planId,      32)
            .storeUint(1,            2)  // PAYMENT_TON = 1
            .endCell();

        await tonConnectUI.sendTransaction({
            validUntil: Math.floor(Date.now() / 1000) + 300,
            messages: [{
                address: FACTORY_ADDRESS,
                amount:  String(planPrice + toNano("0.2")),
                payload: body.toBoc().toString("base64"),
            }],
        });
    }

    return <button onClick={handleSubscribe}>Подписаться</button>;
}
```

### Jetton-подписка

Для Jetton (например, USDT) дополнительно укажите адрес Jetton-кошелька подписчика:

```typescript
const body = beginCell()
    .storeUint(0x4F520001, 32)
    .storeUint(0,           64)
    .storeUint(planId,      32)
    .storeUint(2,            2)   // PAYMENT_JETTON = 2
    .storeAddress(subscriberJettonWalletAddress)  // адрес Jetton-кошелька подписчика
    .endCell();

// value — только TON для газа (Jetton-токены отправляются отдельно)
// Минимум: 0.2 TON; рекомендуем: 0.3 TON
```

---

## 2. Webhook — приём событий списания

После каждого подтверждённого списания relayer отправляет POST на ваш `WEBHOOK_URL`:

```json
{
  "event":      "charge_confirmed",
  "address":    "EQAem3BPC7PvJzPGItrwNDVizMSqFIZ0nUDZvebfB4NBDn5w",
  "seqno_from": 0,
  "seqno_to":   1,
  "timestamp":  1747374000
}
```

| Поле | Описание |
|---|---|
| `address` | Адрес Subscription-контракта подписчика |
| `seqno_from` | Seqno до списания |
| `seqno_to` | Seqno после (= количество успешных списаний) |
| `timestamp` | Unix-время события |

### Настройка relayer

```env
WEBHOOK_URL=https://api.yourapp.com/orbit/webhook
WEBHOOK_SECRET=длинная-случайная-строка-минимум-32-символа
```

Сгенерировать секрет:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Обработчик webhook (Node.js)

```typescript
import * as http from "http";

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";

const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/orbit/webhook") {
        res.writeHead(404); res.end(); return;
    }

    // 1. Проверяем секрет
    if (WEBHOOK_SECRET && req.headers["x-orbit-secret"] !== WEBHOOK_SECRET) {
        res.writeHead(401); res.end("Unauthorized"); return;
    }

    // 2. Читаем тело
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
        try {
            const event = JSON.parse(body);
            if (event.event === "charge_confirmed") {
                await onChargeConfirmed(event.address, event.seqno_to);
            }
            res.writeHead(200); res.end("OK");
        } catch {
            res.writeHead(400); res.end("Bad Request");
        }
    });
});

async function onChargeConfirmed(subscriptionAddress: string, seqno: number) {
    // Ваша логика: найти пользователя по subscriptionAddress и выдать доступ
    console.log(`Списание подтверждено: ${subscriptionAddress}, seqno=${seqno}`);
    // Пример:
    // const user = await db.users.findOne({ subscriptionAddress });
    // if (user) await grantAccess(user.id, billingPeriodDays);
}

server.listen(3001);
```

Готовый расширяемый пример: [`scripts/webhook-server.ts`](../scripts/webhook-server.ts)

### Дополнительная верификация on-chain (опционально)

Для максимальной безопасности проверяйте seqno прямо на блокчейне:

```typescript
import { TonClient, Address } from "@ton/ton";
import { Subscription }       from "../wrappers/Subscription";

const client = new TonClient({
    endpoint: "https://toncenter.com/api/v2/jsonRPC",
    apiKey:   process.env.TONCENTER_API_KEY,
});

async function onChargeConfirmed(address: string, seqnoTo: number) {
    // Верифицируем seqno on-chain — нельзя подделать даже при утечке WEBHOOK_SECRET
    const sub       = client.open(Subscription.createFromAddress(Address.parse(address)));
    const realSeqno = await sub.getSeqno();
    if (realSeqno < seqnoTo) {
        console.error("Подозрительный payload — seqno не совпадает");
        return;
    }
    // Выдаём доступ
}
```

---

## 3. Проверка статуса подписки

```typescript
import { TonClient, Address } from "@ton/ton";
import { Subscription }       from "../wrappers/Subscription";

const client = new TonClient({
    endpoint: "https://toncenter.com/api/v2/jsonRPC",
    apiKey:   process.env.TONCENTER_API_KEY,
});

const sub = client.open(
    Subscription.createFromAddress(Address.parse("EQD...адрес_подписки..."))
);

// Все геттеры вызываются без аргументов:
const status      = await sub.getStatus();           // число (см. таблицу ниже)
const seqno       = await sub.getSeqno();            // кол-во успешных списаний
const nextBilling = await sub.getNextBillingTime();  // unix timestamp
const deposit     = await sub.getDeposit();          // остаток депозита в nanoTON
```

**Коды статуса:**

| Код | Константа | Значение |
|---|---|---|
| 1 | `STATUS_TRIAL` | Бесплатный trial, списания ещё не было |
| 2 | `STATUS_ACTIVE` | Активна, платежи идут |
| 3 | `STATUS_PAUSED` | На паузе (подписчик или сервис) |
| 4 | `STATUS_GRACE` | Недостаточно средств, грейс-период (3 дня) |
| 5 | `STATUS_CANCELLED` | Отменена, депозит возвращён |

---

## 4. Предварительный расчёт адреса подписки

Адрес Subscription-контракта детерминирован — его можно вычислить до того, как пользователь подпишется:

```typescript
import { Factory } from "../wrappers/Factory";
import { TonClient, Address } from "@ton/ton";

const client  = new TonClient({ endpoint: "..." });
const factory = client.open(Factory.createFromAddress(Address.parse(FACTORY_ADDRESS)));

// Адрес подписки определяется: factory + subscriber + plan_id
const subscriptionAddress = await factory.getSubscriptionAddress(
    subscriberAddress,  // Address объект
    planId,             // number
);

console.log("Адрес подписки:", subscriptionAddress.toString());
```

Используйте этот адрес в БД чтобы связать кошелёк пользователя с его подпиской.

---

## 5. Проверка тарифных планов Factory

```typescript
import { Factory } from "../wrappers/Factory";
import { TonClient, Address } from "@ton/ton";

const factory = client.open(Factory.createFromAddress(Address.parse(FACTORY_ADDRESS)));
const plans = await factory.getPlans();

for (const plan of plans) {
    if (!plan.active) continue;
    console.log(`Plan ${plan.planId}:`);
    console.log(`  Цена:    ${plan.price / 1_000_000_000n} TON`);
    console.log(`  Период:  ${plan.period / 86400} дней`);
    console.log(`  Trial:   ${plan.trialPeriod > 0 ? plan.trialPeriod / 86400 + " дней" : "нет"}`);
}
```

---

## 6. React SDK (в разработке)

Исходный код SDK находится в `sdk/react/`. На npm пока не опубликован. Следите за релизами.

После публикации будет доступен:
```bash
npm install @orbit-ton/react
```

---

## Устранение неполадок

| Симптом | Причина | Решение |
|---|---|---|
| Транзакция сразу отбивается | Неверный `payment_type` (0 — невалидно) | Используйте `PAYMENT_TON = 1` |
| Транзакция сразу отбивается | Недостаточно TON в value | `value >= plan_price + 0.1 TON` |
| Relayer не видит подписку | `msg_data.init_state` не проверялся | Обновлено в текущей версии |
| Relayer видит 0 подписок | Неправильный `FACTORY_ADDRESS` в `.env` | Проверить адрес Factory |
| Webhook не приходит | `WEBHOOK_URL` или `WEBHOOK_SECRET` не совпадают | Одинаковые значения на сервере и в relayer `.env` |
| `Error on ...: status 500` | Подписка истощила депозит | Нормально для тестовой подписки; пополните депозит |
| `getSeqno(provider)` — ошибка | Устаревший API | Вызывайте без аргументов: `await sub.getSeqno()` |
