# terra-lint

A powerful and fast Terra config pack validator and linter built with Node.js and TypeScript.

## Features

- **🚀 Fast Discovery**: Recursively scans your pack to index all config objects.
- **📍 Precise Diagnostics**: Reports syntax errors and logical issues with exact file, line, and column locations.
- **🔗 Meta Reference Resolution**: Fully resolves `$file.yml:path` lookups and `<<` meta merges.
- **🧬 Inheritance Support**: Computes "effective" config values by resolving `extends` chains (including circular dependency detection).
- **📂 CI-Ready**: Designed for local development and automated CI/CD pipelines.

## Installation

### Prerequisites
- [Node.js](https://nodejs.org/) (v20 or higher recommended)
- [npm](https://www.npmjs.com/)

### Local Setup
1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the project:
   ```bash
   npm run build
   ```

### Global Installation (CLI)
To use `terra-lint` from anywhere on your system, you can install it globally or link it:

**Option A: Install globally**
```bash
npm install -g .
```

**Option B: Link for development**
```bash
npm link
```

## Usage

Run the linter by providing the path to your Terra config pack root:

```bash
terra-lint <path-to-pack>
```

### Options

| Flag | Description |
| --- | --- |
| `--help` | Show help information. |
| `--version` | Show version information. |
| `--json` | Output diagnostics in JSON format for automated processing. |
| `--strict` | Treat warnings as errors (coming soon). |
| `--max-warnings` | Set a limit for allowed warnings (coming soon). |

## Project Status

`terra-lint` is currently in active development.

- [x] Milestone 0-2: CLI, Parser, Pack Discovery, Registry
- [x] Milestone 3: Meta Reference Resolution
- [x] Milestone 4: Inheritance Resolution (`extends`)
- [ ] Milestone 5: Core Schemas (`pack.yml`, `BIOME`, etc.) - **Next Up**
- [ ] Milestone 6: Cross-reference rules
- [ ] Milestone 7: Expression sanity checks
- [ ] Milestone 8: Linting rules (style, formatting)

## License

[ISC](LICENSE)
