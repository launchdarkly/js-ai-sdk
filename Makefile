.PHONY: start build clean test typecheck lint lint-fix lint-packages lint-packages-fix format format-fix code-check code-fix review size size-install audit

# Fail on known high or critical vulnerabilities in runtime (non-dev) dependencies
# Yarn 1 exits with a bitmask of severities found (info 1, low 2, moderate 4, high 8, critical 16) and
# --level only filters the printed list, so test bits 8|16. Exactly 1 is also yarn's error exit: fail closed.
audit:
	yarn audit --groups dependencies --level high; s=$$?; \
	if [ $$s -eq 1 ] || [ $$((s & 24)) -ne 0 ]; then echo "make audit: failed (yarn audit exit $$s)"; exit 1; fi

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
