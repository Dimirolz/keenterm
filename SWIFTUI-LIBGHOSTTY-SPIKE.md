# SwiftUI + libghostty Spike

Дата: 2026-06-19.

## Идея

Сделать native macOS control panel поверх OrbStack:

```text
macOS app
  -> OrbStack machines через orbctl/orb
  -> terminal tabs через libghostty
  -> diff/review UI пока оставить web-based
```

Рабочее имя:

```text
internal: OrbAgent
public candidates: KeenFleet / KeenBox / AgentDock
```

## Почему это направление

Замена OrbStack снизу упёрлась в memory reclaim:

```text
Apple VZ: нет VIRTIO_BALLOON_F_REPORTING
libkrun: reporting есть, но host footprint не падает как у OrbStack
OrbStack: custom VMM memory manager, mach_vm_remap path
```

Зато UI/control-plane поверх OrbStack выглядит реалистично:

```text
мы не конкурируем с OrbStack
мы делаем vertical add-on для agent fleets
```

## libghostty context

Ghostty сам устроен так:

```text
macOS GUI: Swift / AppKit / SwiftUI
terminal core/rendering: libghostty C API
```

Официальные docs говорят, что `libghostty` — C-ABI library для terminal
emulation, font handling и rendering. Но API всё ещё может быть нестабильным.

Дополнительный сигнал: по свежему OrbStack changelog, OrbStack сам использует
`libghostty` для terminal UI. Это делает стек менее экспериментальным для
нашего use case: мы фактически идём тем же terminal-rendering путём поверх
OrbStack.

Есть сторонние варианты:

```text
libghostty-spm / GhosttyKit
Termini
Forge / conterm / другие examples из awesome-libghostty
```

Главный spike question:

```text
можно ли быстро embedded terminal surface на SwiftUI/AppKit
и подключить его к local PTY process `orb -m <machine> ...`
```

## MVP scope

Первый экран:

```text
sidebar:
  machines from `orbctl list`

main:
  terminal tab connected to selected machine

actions:
  start
  stop
  open shell
  clone later
```

Diff/review не тащим в Swift на первом этапе.

## Spike phases

### Phase 0 — repo skeleton

Цель:

```text
пустое macOS Swift app запускается локально
```

Варианты:

```text
Xcode project
Swift Package + App target
```

Минимум:

```text
SwiftUI window
sidebar placeholder
main placeholder
```

### Phase 1 — orbctl bridge

Цель:

```text
показать список OrbStack machines
```

Команды:

```bash
orbctl list
orbctl start <name>
orbctl stop <name>
```

Нужно:

```text
Process wrapper
stdout capture
simple parser
async refresh
```

Success:

```text
app shows shilo-agent-base / shilo-agent-1 with status
start/stop buttons work
```

### Phase 2 — terminal without libghostty fallback

Цель:

```text
проверить PTY/session model отдельно от rendering
```

Команда:

```bash
orb -m shilo-agent-base bash
```

Fallback UI:

```text
NSTextView или WebView/xterm.js
```

Success:

```text
interactive shell works
resize model understood
stdin/stdout loop stable
```

### Phase 3 — libghostty/GhosttyKit

Цель:

```text
заменить fallback terminal view на libghostty-backed view
```

Проверить:

```text
SwiftPM dependency viability
AppKit/SwiftUI embedding
PTY input/output API
resize
clipboard
colors
mouse
IME
font rendering
```

Success:

```text
`orb -m <machine> bash` работает в libghostty terminal
Codex TUI запускается
resize не ломает layout
keyboard shortcuts не конфликтуют
```

### Phase 4 — Codex workflow

Цель:

```text
native shell реально удобен для agents
```

Проверить:

```bash
orb -m shilo-agent-base codex
```

Критерии:

```text
streaming output smooth
alternate screen works
OSC/title/spinner не ломаются
copy/paste ok
scrollback ok
```

## Architecture sketch

```text
App
  MachinesStore
    -> OrbctlClient
  TerminalSessionStore
    -> PtyProcess / ProcessBridge
    -> Orb command
  TerminalView
    -> libghostty/GhosttyKit
```

Первый backend:

```text
OrbStack only
```

Позже можно:

```text
backend protocol: OrbStack | Incus | local shell
```

## Technical risks

### libghostty maturity

Риск:

```text
API unstable, examples мало, SwiftPM wrapper может отставать
```

Mitigation:

```text
сначала isolated terminal PoC
не завязывать весь app на libghostty сразу
иметь xterm.js fallback
```

### PTY in Swift

Риск:

```text
Process stdout pipe != true PTY
TUI требует pty, raw mode, resize
```

Нужно:

```text
forkpty/openpty wrapper
SIGWINCH / window size
nonblocking IO
```

### OrbStack command UX

Риск:

```text
orbctl output may be text-only
orb command quoting/pty edge cases
```

Mitigation:

```text
start with shell command exactly:
orb -m NAME bash
```

### Diff UI

Риск:

```text
Swift хуже для rich diff/code review
Shiki/Monaco/CodeMirror в browser сильнее
```

Decision:

```text
не переписывать diff в Swift в MVP
оставить existing web diff/review surface
```

## Product shape

MVP should feel like:

```text
OrbStack-native agent workspace manager
```

Not:

```text
replacement for OrbStack
full IDE
full diff platform
```

Core value:

```text
start/clone/manage agent machines
open terminal tabs
keep current review/diff flow
```

## Rough estimate

```text
Spike:
  2-4 days

Useful MVP:
  1-2 weeks

Polished app:
  3-6 weeks
```

If libghostty integration is painful:

```text
xterm.js/Electron/Tauri path probably wins
```

## First concrete task

Build smallest app:

```text
SwiftUI window
button: refresh machines
list: orbctl list
button: open terminal
terminal: fallback PTY view or GhosttyKit if easy
command: orb -m shilo-agent-base bash
```

Success demo:

```text
launch app
see machines
start shilo-agent-base
open terminal
run `codex --version`
```

## Spike implementation

Added local SwiftPM app:

```text
control-plane/macos
```

Run:

```bash
cd control-plane
pnpm dev:server

cd control-plane/macos
swift run
```

Current shape:

```text
SwiftUI sidebar -> existing control-plane API on :7070
native buttons -> create/start/stop/stack-up
native PTY -> forkpty + orb -m <machine> bash -lc codex --yolo
```

This intentionally skips `libghostty` for the first spike. It proves the app
shape and agent lifecycle first. The terminal renderer is raw `NSTextView`, so
ANSI/TUI rendering is not production quality yet.

Next replacement seam:

```text
TerminalView(NSTextView)
  -> TerminalView(libghostty/GhosttyKit)
```
