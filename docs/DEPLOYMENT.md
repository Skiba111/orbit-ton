# Руководство по деплою ORBIT

## Что деплоится и кем

| Контракт | Кто деплоит | Когда |
|---|---|---|
| **FeeCollector** | ORBIT-команда (один раз) | Перед любым Factory |
| **Factory** | Оператор сервиса | Один раз на сервис |
| **Subscription** | Factory автоматически | При каждой подписке пользователя |

---

## Требования

- Node.js 18+
- `ts-node` (устанавливается через `npm install` в репозитории)
- Кошелёк TON с балансом ≥ 2 TON
- Два Ed25519 ключа (генерируются ниже)

---

## Шаг 0 — Генерация ключей

Нужны два отдельных ключа:

| Ключ | Режим хранения | Для чего |
|---|---|---|
| **Relayer key** | Hot (на сервере в `.env`) | Подписывает внешние сообщения OP_CHARGE_EXT |
| **Fee-collector key** | Cold (hardware / офлайн) | Подписывает вывод комиссий из FeeCollector |

```bash
# Генерация ключа relayer
node -e "
const { mnemonicNew, mnemonicToPrivateKey } = require('@ton/crypto');
mnemonicNew(24).then(async m => {
    console.log('Mnemonic:', m.join(' '));
    const kp = await mnemonicToPrivateKey(m);
    console.log('Pubkey (hex):', Buffer.from(kp.publicKey).toString('hex'));
});
"
# Повторите для fee-collector ключа — мнемонику сохраните офлайн
```

> **Важно:** это два разных ключа! Relayer-ключ лежит на сервере. Fee-collector ключ — офлайн.

---

## Шаг 1 — Настройка .env

```env
# .env в корне репозитория — в .gitignore, НИКОГДА не коммитьте

WALLET_MNEMONIC="слово1 слово2 ... слово24"  # кошелёк для оплаты деплоя
FEE_COLLECTOR_PUBKEY="abcdef1234..."          # hex pubkey fee-collector ключа (холодного)
TONCENTER_API_KEY="ваш_ключ"                 # получить на toncenter.com
NETWORK=testnet                               # testnet | mainnet
WALLET_VERSION=v5                             # v5=Tonkeeper/TG Wallet; v4=старый Tonkeeper
```

Убедитесь что на кошельке достаточно TON:
- **Testnet:** запросите тестовые монеты в @testgiver_ton_bot
- **Mainnet:** минимум 2 TON (1 на FeeCollector + 0.5 на Factory + запас)

---

## Шаг 2 — Деплой FeeCollector и Factory

```bash
ts-node scripts/deploy-standalone.ts
```

Скрипт:
1. Выводит баланс и seqno вашего кошелька (если < 0.5 TON — выдаёт ошибку)
2. Компилирует все Tolk-контракты (~15 секунд)
3. Деплоит FeeCollector (если ещё не задеплоен)
4. Интерактивно запрашивает параметры Factory:
   - **Service owner address** — ваш адрес (управление Factory)
   - **Service fee bps** — комиссия сервиса (100 = 1%, 0 = без комиссии)
   - **Relayer pubkey hex** — hex pubkey RELAYER-ключа
   - **Protocol fee collector address** — адрес FeeCollector (или ORBIT-адрес)
5. Деплоит Factory
6. Выводит итоговые адреса

**Пример вывода:**
```
╔═══════════════════════════════════════════════════════════════╗
║                ORBIT Deployment Complete ✅                   ║
╠═══════════════════════════════════════════════════════════════╣
║  Network      : testnet
║  FeeCollector : EQDDU30Vfvjf4wVgyw5Mzh3aMmcvP7Y0sFb2zQ-2tTNbadze
║  Factory      : EQADc2gC0KFW-vNPeHJ18EFG81YMBWwR6qQsbSSaWCUmQuJ2
╠═══════════════════════════════════════════════════════════════╣
║  → Copy Factory address to FACTORY_ADDRESS in your .env      ║
╚═══════════════════════════════════════════════════════════════╝
```

---

## Шаг 3 — Настройка сервера (VPS)

### Установка Node.js и PM2

```bash
# Ubuntu 22.04
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2 ts-node typescript
```

### Клонирование и зависимости

```bash
git clone https://github.com/Skiba111/orbit-ton.git ~/orbit
cd ~/orbit
npm install --legacy-peer-deps
```

### .env на сервере

```bash
nano ~/orbit/.env
```

```env
# .env на сервере — только переменные для relayer/webhook
FACTORY_ADDRESS="EQD...адрес_Factory..."
RELAYER_MNEMONIC="слово1 слово2 ... слово24"  # мнемоника relayer-ключа
NETWORK=testnet
POLL_INTERVAL_MS=60000
TONCENTER_API_KEY="ваш_ключ"

WEBHOOK_URL=https://api.yourapp.com/orbit/webhook
WEBHOOK_SECRET=длинная-случайная-строка-минимум-32-символа
WEBHOOK_PORT=3001
LOG_FILE=data/charges.log
```

Сгенерировать безопасный `WEBHOOK_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Запуск через PM2

```bash
cd ~/orbit

pm2 start "ts-node scripts/relayer.ts"        --name relayer
pm2 start "npm run webhook"                    --name webhook

pm2 save        # сохранить конфигурацию
pm2 startup     # настроить автостарт (выполните команду которую выведет)

# Проверить
pm2 list
pm2 logs relayer --lines 30
```

### Reverse-proxy (nginx + HTTPS)

```nginx
# /etc/nginx/sites-available/orbit
server {
    listen 443 ssl;
    server_name api.yourapp.com;

    ssl_certificate     /etc/letsencrypt/live/api.yourapp.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourapp.com/privkey.pem;

    location /orbit/ {
        proxy_pass       http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
sudo certbot --nginx -d api.yourapp.com
sudo systemctl reload nginx
```

---

## Шаг 4 — E2E тест (обязательно перед mainnet)

```bash
# В локальном .env добавьте:
WEBHOOK_URL=https://api.yourapp.com/orbit/webhook
WEBHOOK_SECRET=та_же_строка_что_на_сервере

ts-node scripts/test-e2e.ts
```

Тест:
1. POST на webhook (проверяет доступность и секрет)
2. Деплоит тестовую Factory (period=120s, price=0.2 TON)
3. Создаёт подписку с правильным форматом тела
4. Ожидает обнаружения relayer'ом и первого списания

Смотреть логи сервера:
```bash
pm2 logs relayer --lines 30
cat ~/orbit/data/charges.log
```

Ожидаемый результат:
```
[relayer] Discovered subscription: EQD...
[relayer] Initial scan complete (1 pages, 1 subscriptions)
[relayer] Charged EQD... (seqno 0 → 1)
```

---

## Шаг 5 — Mainnet деплой

После успешного E2E на testnet:

```bash
# В .env:
NETWORK=mainnet
TONCENTER_API_KEY="mainnet_ключ"   # отдельный API-ключ для mainnet

# Кошелёк должен иметь ≥ 2 TON реальных монет
ts-node scripts/deploy-standalone.ts
```

На сервере обновить `.env` и перезапустить:
```bash
# Изменить NETWORK=mainnet и FACTORY_ADDRESS на mainnet-адрес
nano ~/orbit/.env
pm2 restart relayer --update-env
pm2 restart webhook --update-env
```

---

## Обновление кода на сервере

```bash
cd ~/orbit
git pull
pm2 restart relayer --update-env
pm2 restart webhook --update-env
```

---

## Обновление контрактов

Контракты ORBIT immutable после деплоя. Для обновления:
1. Задеплоить новую Factory с обновлённым `subCode`
2. Существующие подписки продолжают работать на старом коде
3. Новые подписки деплоятся с новым кодом
4. Обновить `FACTORY_ADDRESS` в `.env` relayer'а

Механизма апгрейда нет намеренно — это свойство безопасности.

---

## Справочник адресов

| Контракт | Testnet | Mainnet |
|---|---|---|
| FeeCollector | `EQDDU30Vfvjf4wVgyw5Mzh3aMmcvP7Y0sFb2zQ-2tTNbadze` | *(после деплоя)* |
| Factory (production) | `EQADc2gC0KFW-vNPeHJ18EFG81YMBWwR6qQsbSSaWCUmQuJ2` | *(после деплоя)* |
| Factory (E2E тест) | `EQDYJOcdv9C_Uf3tNqCvgPuAQT-hVxLdOEfJePtSiR_YjVCS` | — |
| Relayer pubkey | `52dfadb8...` | *(может быть другим)* |
