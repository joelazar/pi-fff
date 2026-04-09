# pi-fff

`pi-fff` adds `@...` file path autocomplete to the pi editor using [`@ff-labs/fff-node`](https://www.npmjs.com/package/@ff-labs/fff-node).

## Features

- Type `@` to search files relative to the current project
- Supports quoted paths like `@"my folder/file.ts"`
- Activates automatically on session start
- Installs its runtime dependency automatically via npm

## Installation

### From npm

```bash
pi install npm:pi-fff
```

### From git

```bash
pi install git+https://github.com/ShpetimA/pi-fff.git
```

Restart pi after installation.

## Usage

In the editor, type:

```text
@readme
@src/index
@"folder with spaces/file"
```

Autocomplete suggestions will be provided from the current project directory.

## Notes

- Runtime search is powered by `@ff-labs/fff-node`
- No separate manual install step for `fff-node` should be needed for end users
- pi provides the host APIs used by this extension

## Package metadata

This package exposes a pi extension via:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

## Development

Local source entrypoint:

- `index.ts`

Original source reference retained in this repo:

- `fff-at.ts`
