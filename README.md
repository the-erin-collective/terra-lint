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

### Examples

**Basic linting with colored output:**
```bash
terra-lint ./my-pack
```

**Workspace mode (scan for all packs):**
```bash
terra-lint ./workspace --workspace
```

**JSON output for CI/automation:**
```bash
terra-lint ./my-pack --format json
```

**Compact format for CI logs:**
```bash
terra-lint ./my-pack --format compact
```

**Plain output (no colors):**
```bash
terra-lint ./my-pack --format plain
```

**Treat warnings as errors:**
```bash
terra-lint ./my-pack --warnings-as-errors
```

**Custom color settings:**
```bash
terra-lint ./my-pack --color never  # Force no colors
terra-lint ./my-pack --color always # Force colors
```

### Options

| Flag | Description |
| --- | --- |
| `--help` | Show help information. |
| `--version` | Show version information. |
| `--color <auto|always|never>` | Control color output (default: auto). |
| `--format <pretty|plain|json|compact>` | Output format (default: pretty). |
| `--warnings-as-errors` | Treat warnings as errors. |
| `--max-warnings <number>` | Set a limit for allowed warnings (default: -1). |
| `--structure-ext <csv>` | Comma-separated structure extensions (default: "nbt"). |
| `--include <dir>` | Add external directory for meta-reference resolution. |
| `--ignore <glob>` | Ignore files matching the given glob patterns. |
| `--config <path>` | Path to custom config file. |
| `--profile <name>` | Use a specific profile from the config file. |
| `--workspace` | Enable workspace mode (scan for all pack.yml files). |

#### Output Formats

- **pretty** (default): Colored output with banners and detailed formatting
- **plain**: Same layout as pretty but without colors
- **json**: Machine-readable JSON output with summary statistics
- **compact**: CI-friendly format with one line per issue

## Roadmap

### 📋 Cross-Reference Rules
Enhanced validation for cross-references between different config objects:
- Invalid type references (e.g., biome referencing non-existent features)
- Advanced cross-file dependency analysis and optimization suggestions
- Broken meta-reference path validation and resolution improvements
- Comprehensive reference validation and dependency mapping

### 🧮 Expression Sanity Checks
Advanced validation of Terra expressions beyond basic syntax:
- Division by zero detection and mathematical error prevention
- Out-of-bounds values and type checking for specific contexts
- Performance warnings for complex expressions
- Expression optimization suggestions and best practices

### 🎨 Linting Rules (Style, Formatting)
Code style and formatting best practices for Terra configs:
- Consistent indentation checking and formatting rules
- Naming convention enforcement for IDs and fields
- Field ordering recommendations and best practices
- Unused variable/field detection and cleanup suggestions
- Deprecated field usage warnings and migration guidance
- Performance optimization recommendations

## License

[AGPL-3.0](LICENSE)
