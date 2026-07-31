.PHONY: start build clean test typecheck lint lint-fix lint-packages lint-packages-fix format format-fix code-check code-fix review size size-install

# Run main.ts (yarn start)
start:
	yarn start

# Compile TypeScript (yarn build)
build:
	yarn build

# Remove compiled output (yarn clean)
clean:
	yarn clean

# Run all package tests (yarn test)
test:
	yarn test

# Type-check all packages (yarn typecheck)
typecheck:
	yarn typecheck

# Lint all files (yarn lint)
lint:
	yarn lint

# Auto-fix lint issues (yarn lint:fix)
lint-fix:
	yarn lint:fix

# Check package.json consistency (yarn lint:pkg)
lint-packages:
	yarn lint:pkg

# Fix package.json consistency issues (yarn lint:pkg:fix)
lint-packages-fix:
	yarn lint:pkg:fix

# Auto-format all files (yarn format)
format:
	yarn format

# Check formatting without writing (yarn format:check)
format-check:
	yarn format:check

# Format + lint check — used in CI (yarn code:check)
code-check:
	yarn code:check

# Format + lint with auto-fix (yarn code:fix)
code-fix:
	yarn code:fix

# Run code review agent (yarn review)
review:
	yarn review

# Show packed size for a package — usage: make size PKG=<package-name>
size:
	yarn size $(PKG)

# Show install size for a package — usage: make size-install PKG=<package-name>
size-install:
	yarn size:install $(PKG)
