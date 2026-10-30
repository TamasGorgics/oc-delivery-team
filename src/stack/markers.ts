import type { StackCommands, StackGlobs } from "./profile";

export type MarkerKind = "component" | "tooling";

export interface PackageManagerMarker {
  readonly marker: string;
  readonly name: string;
}

export interface MarkerRule {
  readonly id: string;
  /** A component marker creates a stack component; tooling markers only annotate the profile. */
  readonly kind: MarkerKind;
  readonly languages: readonly string[];
  readonly frameworks?: readonly string[];
  readonly manifests: readonly string[];
  readonly packageManagers?: readonly PackageManagerMarker[];
  readonly commands?: Partial<StackCommands>;
  readonly globs?: Partial<StackGlobs>;
  readonly note?: string;
}

export interface WorkspaceMarker {
  readonly id: string;
  readonly manifests: readonly string[];
  readonly note: string;
}

export const JS_SOURCE_GLOBS = [
  "**/*.js",
  "**/*.jsx",
  "**/*.mjs",
  "**/*.cjs",
  "**/*.ts",
  "**/*.tsx",
  "**/*.mts",
  "**/*.cts",
] as const;

export const JS_TEST_GLOBS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
] as const;

export const JS_IGNORE_GLOBS = [
  "node_modules/**",
  "dist/**",
  "build/**",
  ".next/**",
  "coverage/**",
  ".turbo/**",
] as const;

export const PACKAGE_MANAGERS: readonly PackageManagerMarker[] = [
  { marker: "pnpm-lock.yaml", name: "pnpm" },
  { marker: "yarn.lock", name: "yarn" },
  { marker: "bun.lock", name: "bun" },
  { marker: "bun.lockb", name: "bun" },
  { marker: "package-lock.json", name: "npm" },
  { marker: "npm-shrinkwrap.json", name: "npm" },
];

/**
 * Adding an ecosystem means adding a row here. Detection code only knows how
 * to merge component markers, task runners, and tooling notes.
 */
export const MARKER_RULES: readonly MarkerRule[] = [
  {
    id: "javascript",
    kind: "component",
    languages: ["javascript"],
    manifests: ["package.json"],
    packageManagers: PACKAGE_MANAGERS,
    globs: {
      source: JS_SOURCE_GLOBS,
      tests: JS_TEST_GLOBS,
      docs: ["README*", "docs/**", "**/*.md"],
      ignore: JS_IGNORE_GLOBS,
    },
  },
  {
    id: "typescript",
    kind: "component",
    languages: ["typescript"],
    manifests: ["tsconfig.json", "tsconfig.*.json"],
    globs: { source: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"] },
  },
  {
    id: "python",
    kind: "component",
    languages: ["python"],
    manifests: ["pyproject.toml", "requirements*.txt", "setup.py", "Pipfile", "poetry.lock", "uv.lock"],
    commands: {
      install: "python -m pip install -e .",
      test: "python -m pytest",
      format: "python -m black .",
      typecheck: "python -m mypy .",
    },
    globs: {
      source: ["**/*.py"],
      tests: ["**/test_*.py", "**/*_test.py", "**/tests/**"],
      docs: ["README*", "docs/**", "**/*.md"],
      ignore: [".venv/**", "venv/**", "__pycache__/**", ".pytest_cache/**"],
    },
  },
  {
    id: "go",
    kind: "component",
    languages: ["go"],
    manifests: ["go.mod", "go.work"],
    commands: {
      install: "go mod download",
      build: "go build ./...",
      test: "go test ./...",
      lint: "go vet ./...",
      format: "gofmt -w .",
      typecheck: null,
      run: null,
    },
    globs: {
      source: ["**/*.go"],
      tests: ["**/*_test.go"],
      docs: ["README*", "docs/**", "**/*.md"],
      ignore: ["vendor/**"],
    },
  },
  {
    id: "rust",
    kind: "component",
    languages: ["rust"],
    manifests: ["Cargo.toml"],
    commands: {
      install: "cargo fetch",
      build: "cargo build",
      test: "cargo test",
      lint: "cargo clippy --all-targets",
      format: "cargo fmt",
      typecheck: "cargo check",
      run: null,
    },
    globs: {
      source: ["**/*.rs"],
      tests: ["**/tests/**", "**/*_test.rs"],
      docs: ["README*", "docs/**", "**/*.md"],
      ignore: ["target/**"],
    },
  },
  {
    id: "maven",
    kind: "component",
    languages: ["java", "kotlin"],
    frameworks: ["maven"],
    manifests: ["pom.xml"],
    commands: {
      install: "mvn dependency:go-offline",
      build: "mvn package -DskipTests",
      test: "mvn test",
      lint: null,
      format: null,
      typecheck: null,
      run: null,
    },
    globs: {
      source: ["**/*.java", "**/*.kt"],
      tests: ["src/test/**"],
      docs: ["README*", "docs/**", "**/*.md"],
      ignore: ["target/**"],
    },
  },
  {
    id: "gradle",
    kind: "component",
    languages: ["java", "kotlin"],
    frameworks: ["gradle"],
    manifests: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
    commands: {
      install: null,
      build: "gradle build -x test",
      test: "gradle test",
      lint: null,
      format: null,
      typecheck: null,
      run: null,
    },
    globs: {
      source: ["**/*.java", "**/*.kt"],
      tests: ["src/test/**"],
      docs: ["README*", "docs/**", "**/*.md"],
      ignore: ["build/**", ".gradle/**"],
    },
  },
  {
    id: "dotnet",
    kind: "component",
    languages: ["csharp", "fsharp", "vb"],
    frameworks: ["dotnet"],
    manifests: ["*.sln", "*.csproj", "*.fsproj", "*.vbproj"],
    commands: {
      install: "dotnet restore",
      build: "dotnet build",
      test: "dotnet test",
      lint: null,
      format: "dotnet format",
      typecheck: null,
      run: null,
    },
    globs: {
      source: ["**/*.cs", "**/*.fs", "**/*.vb"],
      tests: ["**/*Tests.cs", "**/*Test.cs", "**/*.Tests/**"],
      docs: ["README*", "docs/**", "**/*.md"],
      ignore: ["bin/**", "obj/**"],
    },
  },
  {
    id: "ruby",
    kind: "component",
    languages: ["ruby"],
    manifests: ["Gemfile", "gems.rb", "*.gemspec"],
    commands: {
      install: "bundle install",
      build: null,
      test: "bundle exec rake test",
      lint: "bundle exec rubocop",
      format: null,
      typecheck: null,
      run: null,
    },
    globs: {
      source: ["**/*.rb"],
      tests: ["spec/**", "test/**", "**/*_spec.rb", "**/*_test.rb"],
      docs: ["README*", "docs/**", "**/*.md"],
      ignore: ["vendor/bundle/**", "tmp/**"],
    },
  },
  {
    id: "php",
    kind: "component",
    languages: ["php"],
    manifests: ["composer.json"],
    commands: {
      install: "composer install",
      build: null,
      test: null,
      lint: null,
      format: null,
      typecheck: null,
      run: null,
    },
    globs: {
      source: ["**/*.php"],
      tests: ["tests/**", "**/*Test.php"],
      docs: ["README*", "docs/**", "**/*.md"],
      ignore: ["vendor/**"],
    },
  },
  {
    id: "elixir",
    kind: "component",
    languages: ["elixir"],
    frameworks: ["elixir"],
    manifests: ["mix.exs"],
    commands: {
      install: "mix deps.get",
      build: "mix compile",
      test: "mix test",
      lint: null,
      format: "mix format",
      typecheck: "mix compile --warnings-as-errors",
      run: null,
    },
    globs: {
      source: ["**/*.ex", "**/*.exs"],
      tests: ["test/**", "**/*_test.exs"],
      docs: ["README*", "docs/**", "**/*.md"],
      ignore: ["_build/**", "deps/**"],
    },
  },
  {
    id: "swift",
    kind: "component",
    languages: ["swift"],
    manifests: ["Package.swift"],
    commands: {
      install: "swift package resolve",
      build: "swift build",
      test: "swift test",
      lint: null,
      format: null,
      typecheck: null,
      run: null,
    },
    globs: {
      source: ["**/*.swift"],
      tests: ["Tests/**"],
      docs: ["README*", "docs/**", "**/*.md"],
      ignore: [".build/**"],
    },
  },
  {
    id: "cmake",
    kind: "component",
    languages: ["c", "cpp"],
    frameworks: ["cmake"],
    manifests: ["CMakeLists.txt"],
    commands: {
      install: "cmake -S . -B build",
      build: "cmake --build build",
      test: "ctest --test-dir build",
      lint: null,
      format: null,
      typecheck: null,
      run: null,
    },
    globs: {
      source: ["**/*.c", "**/*.cc", "**/*.cpp", "**/*.h", "**/*.hpp"],
      tests: ["test/**", "tests/**"],
      docs: ["README*", "docs/**", "**/*.md"],
      ignore: ["build/**"],
    },
  },
  {
    id: "meson",
    kind: "component",
    languages: ["c", "cpp"],
    frameworks: ["meson"],
    manifests: ["meson.build"],
    commands: {
      install: "meson setup build",
      build: "meson compile -C build",
      test: "meson test -C build",
      lint: null,
      format: null,
      typecheck: null,
      run: null,
    },
    globs: {
      source: ["**/*.c", "**/*.cc", "**/*.cpp", "**/*.h", "**/*.hpp"],
      tests: ["test/**", "tests/**"],
      docs: ["README*", "docs/**", "**/*.md"],
      ignore: ["build/**"],
    },
  },
  {
    id: "dart",
    kind: "component",
    languages: ["dart"],
    manifests: ["pubspec.yaml"],
    commands: {
      install: "dart pub get",
      build: null,
      test: "dart test",
      lint: "dart analyze",
      format: "dart format .",
      typecheck: null,
      run: null,
    },
    globs: {
      source: ["**/*.dart"],
      tests: ["test/**", "**/*_test.dart"],
      docs: ["README*", "docs/**", "**/*.md"],
      ignore: [".dart_tool/**", "build/**"],
    },
  },
  {
    id: "make",
    kind: "component",
    languages: [],
    frameworks: ["make"],
    manifests: ["Makefile", "makefile", "GNUmakefile"],
    globs: { ignore: ["node_modules/**", "vendor/**"] },
  },
  {
    id: "just",
    kind: "component",
    languages: [],
    frameworks: ["just"],
    manifests: ["justfile", "Justfile"],
    globs: { ignore: ["node_modules/**", "vendor/**"] },
  },
  {
    id: "task",
    kind: "component",
    languages: [],
    frameworks: ["task"],
    manifests: ["Taskfile.yml", "Taskfile.yaml"],
    globs: { ignore: ["node_modules/**", "vendor/**"] },
  },
  {
    id: "docker",
    kind: "tooling",
    languages: [],
    manifests: ["Dockerfile", "Containerfile", "docker-compose*.yml", "docker-compose*.yaml", "compose*.yml", "compose*.yaml"],
    note: "Container definitions detected.",
  },
  {
    id: "nix",
    kind: "tooling",
    languages: [],
    manifests: ["flake.nix", "default.nix", "shell.nix"],
    note: "Nix definitions detected.",
  },
  {
    id: "ci",
    kind: "tooling",
    languages: [],
    manifests: [".github/workflows/*.yml", ".github/workflows/*.yaml", ".gitlab-ci.yml", ".circleci/config.yml"],
    note: "CI configuration detected.",
  },
];

export const WORKSPACE_MARKERS: readonly WorkspaceMarker[] = [
  { id: "pnpm", manifests: ["pnpm-workspace.yaml"], note: "pnpm workspace" },
  { id: "yarn", manifests: [".yarnrc.yml"], note: "Yarn workspace" },
  { id: "lerna", manifests: ["lerna.json"], note: "Lerna monorepo" },
  { id: "nx", manifests: ["nx.json"], note: "Nx monorepo" },
  { id: "turbo", manifests: ["turbo.json"], note: "Turborepo monorepo" },
  { id: "go-work", manifests: ["go.work"], note: "Go workspace" },
  { id: "cargo-workspace", manifests: ["Cargo.toml"], note: "Cargo workspace candidate" },
  { id: "dotnet-solution", manifests: ["*.sln"], note: ".NET solution" },
  { id: "gradle-settings", manifests: ["settings.gradle", "settings.gradle.kts"], note: "Gradle multi-project" },
  { id: "maven-modules", manifests: ["pom.xml"], note: "Maven multi-module candidate" },
  { id: "composer", manifests: ["composer.json"], note: "Composer package" },
];

export const DEFAULT_COMMANDS: StackCommands = {
  install: null,
  build: null,
  test: null,
  lint: null,
  format: null,
  typecheck: null,
  run: null,
};
