# UI/UX Brief — KeenTerm (native macOS control panel)

> Задача для Codex: довести **native macOS приложение** `KeenTerm` до уровня
> отполированного дизайна, который уже есть в web-панели `keen.fleet`. Сейчас
> Swift-версия — рабочий прототип на дефолтном SwiftUI; web-версия — продуманный
> продукт со своим брендом, состояниями и анимациями. Нужно подтянуть Swift до
> того же уровня полировки и закрыть фичевые пробелы, оставаясь «нативным»
> (SwiftUI/AppKit идиомы, SF Symbols, материалы, корректный window chrome).
>
> **Тема: светлая.** В отличие от тёмной web-панели, macOS-приложение делаем
> светлым/нативным — это сознательное решение. Светлый терминал `.alabaster`
> нравится и остаётся; весь chrome тоже светлый, под него. Из web берём не
> цветовую палитру, а **структуру, состояния, фичи и брендовый акцент**
> (оранжевый «orb», зелёный/жёлтый статусы). Предпочтительно использовать
> системные/адаптивные цвета macOS (`Color(nsColor:)`, materials), чтобы вид был
> нативным и при желании корректно работал в обоих режимах.

## Контекст продукта

KeenTerm — локальный control plane для параллельных кодинг-агентов (OpenAI Codex
CLI). Каждый агент живёт в своей OrbStack VM с копией репо и dev-стеком
(Postgres/Redis/Hasura). Панель плодит/запускает/останавливает агентов и даёт к
каждому терминал. Бренд — **keen.fleet** (метафора: флот/рой агентов, космос).

## Файлы

- Swift app (то, что улучшаем): `control-plane/macos/Sources/KeenTerm/main.swift`
  (один файл, ~470 строк; терминал — `libghostty-spm`/`GhosttyTerminal`).
- Web эталон дизайна:
  - `control-plane/web/src/App.tsx` — структура UI и состояния.
  - `control-plane/web/src/App.css` — дизайн-токены, компоненты, анимации.
  - `control-plane/web/src/index.css` — глобальные цвета/шрифт.
  - `control-plane/web/src/CodexTerminal.tsx`, `DiffViewer.tsx`, `api.ts` — фичи.

API контракт у обеих версий один (`/api/agents`, `start`/`stop`/`stack/up`,
`diff`, `diffStatus`, `DELETE`). Swift сейчас использует не всё.

---

## Что не так сейчас (ревью Swift)

1. **Нет бренда.** Заголовок — plain `Text("keenterm")`. В вебе есть wordmark
   `keen●fleet` со светящимся оранжевым «orb» (radial-gradient + glow).
2. **Тема светлая, и это ок.** Терминал светлый (`TerminalTheme(.alabaster)`,
   фон `0.969` ≈ `#f7f7f7`) — оставляем. Весь chrome тоже делаем светлым под
   него (сайдбар, header, footer, кнопки), используя нативные системные
   материалы/цвета macOS. Сейчас сайдбар на дефолтном фоне — нужно сделать его
   аккуратной светлой панелью с тонкими разделителями и читаемым стыком с
   терминалом.
3. **Голые контролы.** `+` и `refresh` — текстовые кнопки; в вебе это `+ new`
   (primary, оранжевая) и неявный авто-refetch. Per-row кнопки borderless без
   иерархии.
4. **Бедные статусы.** Дот без свечения; «working» — просто оранжевый текст без
   pulse; нет stack-бейджа с тултипом (`pg/redis/hasura ✓/✗`); нет idle-состояния
   codex; нет футера со счётчиками (`N agents · M running`).
5. **Фичевые пробелы vs web:** нет diff-вьювера, нет delete агента, нет кнопки
   «open in VS Code», нет аккуратного error-toast (сейчас красный `Text`).
6. **Пустые состояния** ок (`ContentUnavailableView`), но не брендированы.

---

## Дизайн-токены (светлая тема)

Заведи единый namespace (например `enum Palette`) вместо magic-чисел по коду.
**Для фонов/поверхностей/бордеров предпочитай нативные системные цвета macOS**
(`Color(nsColor: .windowBackgroundColor)`, `.underPageBackgroundColor`,
`.separatorColor`, `.secondaryLabelColor` и т.д.) — они дают правильный светлый
нативный вид и материалы. Жёсткие hex держим только для бренд-акцента и статусов,
которые должны быть узнаваемыми.

| Назначение            | Значение | Заметка |
| --------------------- | -------- | ------- |
| App / terminal chrome | `.windowBackgroundColor` (системный светлый) | нативный фон |
| Sidebar background    | `.underPageBackgroundColor` / sidebar material | чуть отличный от main |
| Panel/overlay surface | `.windowBackgroundColor` + тень | для diff sheet |
| Row hover / selected  | `.selectionColor` / `.quaternaryLabelColor` подложка | нативная подсветка строки |
| Border / separator    | `.separatorColor` | тонкие разделители |
| Terminal              | `#F7F7F7` (`.alabaster`) — **не менять** | Swift `TerminalTheme` |
| Text primary          | `.labelColor` | |
| Text secondary/dim    | `.secondaryLabelColor` | |
| Text muted            | `.tertiaryLabelColor` | footer, mono |
| Accent (orange)       | `#C98429` base / `#B06F1E` darker | бренд-акцент, primary-кнопка |
| Orb gradient          | `#FFD28A → #E8963A → #8A4D12` | wordmark «orb» |
| Status running (green)| `#2FA34A` (+мягкое свечение) | на светлом фоне взять контрастнее, чем web `#4CC26A` |
| Status off (gray)     | `.tertiaryLabelColor` | |
| Warning / working     | `#C9821F` (working/stack partial) | на светлом темнее, чем web `#E8B03A`, для контраста |
| Danger                | `#C0392B` | delete/destructive |

> На светлом фоне неоновые web-цвета (`#4CC26A`, `#E8B03A`) бледнят — бери чуть
> более насыщенные/тёмные варианты, как указано, чтобы держать контраст.

Шрифт: моноширинный (`ui-monospace`/SF Mono) для chrome, как в вебе.
Использовать `.font(.system(.body, design: .monospaced))`.

---

## Конкретные задачи

### 1. Глобальный вид и окно

- Светлый нативный вид всего приложения (системные фоны/материалы macOS),
  терминал светлый — единая светлая тема.
- Сохранить `hiddenTitleBar`, но добавить аккуратный кастомный top-bar в сайдбаре
  (как в web header). Окно без дефолтного toolbar (уже так).
- Применить моноширинный шрифт к chrome.

### 2. Брендовый wordmark

- Заменить `Text("keenterm")` на компонент `Wordmark`: `keen` + светящийся «orb»
  (Circle с `AngularGradient`/`RadialGradient` `#FFD28A→#E8963A→#8A4D12`,
  `.shadow` оранжевый glow) + `fleet`. letter-spacing/жирность как в `.brand`.

### 3. Сайдбар (список агентов)

- Header: `Wordmark` слева, справа primary-кнопка `+ new` (оранжевая, с лоадер-
  текстом `cloning…` при busy). `refresh` убрать в пользу авто-poll (уже есть
  `.task` с 2s), либо оставить иконкой `arrow.clockwise` второстепенной.
- Строка агента (`AgentRow`):
  - status dot: зелёный со свечением (`.shadow`/glow) если running, серый если off;
  - `agent N` (semibold) + имя VM (caption, secondary);
  - **stack-бейдж**: показывать `stack` (зелёный, если все pg/redis/hasura) или
    `stack!` (жёлтый, если частично); tooltip (`.help(...)`) с
    `pg ✓ · redis ✗ · hasura ✓`;
  - **codex индикатор**: `● working` с pulse-анимацией (opacity 1↔0.4, ~1s,
    `.repeatForever`) или `idle` (muted);
  - hover/selected фон и rounded corners (7px), бордер на selected.
  - Экшен-кнопки в ряд с иерархией: start/stop, `fix stack` (если running и стек
    не поднят), `code`, `diff`, `rm` (danger). Состояние busy → спиннер/`…`,
    disabled остальных кнопок строки.
- Footer: `N agents · M running` (muted, 11px) как в `.footer`.
- Пустой список: `no agents yet — create one` по центру (muted).

### 4. Главная панель (terminal)

- **Тему терминала не трогаем** — оставляем светлый `.alabaster`. Так как chrome
  тоже светлый, стык получается естественным; добавить лишь аккуратный
  inset/паддинг и тонкий разделитель (`.separatorColor`) между сайдбаром и
  терминалом.
- Пустые состояния брендировать: «select an agent» (когда ничего не выбрано),
  «VM stopped → Start» с primary-кнопкой (когда выбран, но не running). Сейчас
  есть `ContentUnavailableView` — оставить нативным (он и так светлый), с
  оранжевой primary-кнопкой запуска.

### 5. Закрыть фичевые пробелы (паритет с web)

Реализовать через тот же API (`api.ts` — образец вызовов):

- **Delete агента** (`DELETE /api/agents/{n}`) с подтверждением (`confirm` →
  нативный `.alert`/`NSAlert`), danger-стиль кнопки.
- **Open in VS Code**: открыть URL
  `vscode://vscode-remote/ssh-remote+{name}@orb{REPO_DIR}` через
  `NSWorkspace.shared.open`. `REPO_DIR` взять из env (как `KEENTERM_REPO_DIR`).
- **Diff viewer**: получить `GET /api/agents/{n}/diff` (+ `diff/status` для
  версии/поллинга) и показать в sheet/overlay. Нативно: парсить unified diff и
  рендерить с подсветкой add/del строк (зелёный/красный фон), список изменённых
  файлов слева (как web `DiffViewer` с file-tree). Если своими силами тяжело —
  минимально: monospaced pre с раскраской `+`/`-` строк и заголовком файла.
- **Error toast**: вместо красного `Text` — всплывающий toast снизу по центру
  (светлый красноватый toast: мягкий красный фон, бордер danger `#C0392B`,
  тёмный читаемый текст, авто-дисмисс по клику), анимация появления.

### 6. Микро-полиш

- Кнопки: единый стиль (`ButtonStyle`) на светлом — нейтральная secondary
  (системный bordered), primary оранжевая (бренд-акцент), danger красная.
  disabled opacity ~.45, аккуратный hover.
- Анимации переходов выбора/состояний (`.animation(.easeInOut, value:)`).
- Spinner/`ProgressView` при долгих операциях (create/start/stop).

---

## Definition of Done

- Светлая согласованная нативная тема во всём приложении; терминал светлый
  (`.alabaster`), chrome — системные светлые цвета/материалы macOS.
- Брендовый wordmark с «orb».
- Сайдбар с богатыми статусами (glow dot, stack-бейдж+tooltip, codex pulse,
  футер-счётчики).
- Паритет фич с web: delete, code, diff, error-toast.
- Дизайн-токены вынесены в одно место, без magic-чисел по коду.
- Собирается: `cd control-plane/macos && swift build` без ошибок; приложение
  запускается и работает против локального control-plane сервера.

## Ограничения

- Не менять серверный API и web — только Swift-приложение.
- Оставаться нативным (SwiftUI/AppKit), не тащить webview.
- Минимально-достаточные изменения; не переусложнять архитектуру (можно держать
  всё в одном `main.swift`, но допустимо разбить на файлы, если станет чище).
