import { dirname } from "path";
import { fileURLToPath } from "url";

// === EXTERNAL PLUGINS ===
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import unusedImports from "eslint-plugin-unused-imports";

import security from "eslint-plugin-security";
import noSecrets from "eslint-plugin-no-secrets";
import importPlugin from "eslint-plugin-import-x";
import sonarjs from "eslint-plugin-sonarjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// === CUSTOM RULES PLUGINS ===

// No multiline comments (JSDoc blocks) — project convention
const customCommentsPlugin = {
  rules: {
    "no-multiline-comments": {
      create(context) {
        return {
          Program(node) {
            const filename = context.filename;
            if (filename.includes("node_modules")) return;

            const src = context.sourceCode.getText();

            if (/\/\*\*[\s\S]*?\*\//.test(src)) {
              context.report({
                node,
                message:
                  "JSDoc multiline comments (/** */) not allowed - use single-line comments (//) only",
              });
            }
          },
        };
      },
    },
  },
};

// Prevent placeholder/todo/mock code in production
const customPlaceholderPlugin = {
  rules: {
    "no-placeholder-code": {
      create(context) {
        return {
          Program(node) {
            const filename = context.filename;
            if (filename.includes("node_modules")) return;

            const src = context.sourceCode.getText();

            if (
              /\/\/\s*(TODO|FIXME|HACK|FIX):/i.test(src) ||
              /\/\*[\s\S]*?(TODO|FIXME|HACK|FIX):[\s\S]*?\*\//i.test(src)
            ) {
              context.report({
                node,
                message:
                  "TODO/FIXME/HACK/FIX comments not allowed - implement properly before committing",
              });
            }

            if (/\bmock[A-Z]\w*/.test(src)) {
              context.report({
                node,
                message:
                  "Mock identifiers not allowed in production code - use real implementations",
              });
            }

            if (/@deprecated/i.test(src)) {
              context.report({
                node,
                message:
                  "@deprecated code not allowed - remove or replace with current implementation",
              });
            }
          },
        };
      },
    },
  },
};

const eslintConfig = [
  {
    ignores: [
      "build/**/*",
      "node_modules/**/*",
      "data/**/*",
      "eslint.config.mjs",
    ],
  },

  {
    linterOptions: {
      noInlineConfig: true,
    },
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: __dirname,
        sourceType: "module",
        ecmaVersion: "latest",
      },
    },
    settings: {
      "import-x/resolver": {
        node: {
          extensions: [".js", ".ts"],
        },
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "unused-imports": unusedImports,

      security,
      "no-secrets": noSecrets,
      "import-x": importPlugin,
      sonarjs,
      "custom-comments": customCommentsPlugin,
      "custom-placeholder": customPlaceholderPlugin,
    },
    rules: {
      // === TYPESCRIPT STRICT (17+ RULES) ===
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        {
          assertionStyle: "as",
          objectLiteralTypeAssertions: "never",
        },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/no-implied-eval": "error",
      "@typescript-eslint/restrict-plus-operands": "error",
      "@typescript-eslint/restrict-template-expressions": "error",
      "@typescript-eslint/no-unsafe-enum-comparison": "error",
      "@typescript-eslint/no-base-to-string": "error",

      // === SECURITY (13 RULES) ===
      "security/detect-buffer-noassert": "error",
      "security/detect-child-process": "error",
      "security/detect-disable-mustache-escape": "error",
      "security/detect-eval-with-expression": "error",
      "security/detect-no-csrf-before-method-override": "error",
      // Off: MCPs are file-system tools by design, path-guard validates access
      "security/detect-non-literal-fs-filename": "off",
      "security/detect-non-literal-regexp": "error",
      "security/detect-non-literal-require": "error",
      "security/detect-object-injection": "error",
      "security/detect-possible-timing-attacks": "error",
      "security/detect-pseudoRandomBytes": "error",
      "security/detect-unsafe-regex": "error",
      "no-secrets/no-secrets": "error",

      // === IMPORTS (5 RULES) ===
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "error",
        {
          vars: "all",
          varsIgnorePattern: "",
          args: "after-used",
          argsIgnorePattern: "",
        },
      ],
      "import-x/no-duplicates": "error",
      "import-x/no-cycle": "error",
      "import-x/no-self-import": "error",



      // === SONARJS BUG DETECTION (7 RULES) ===
      "sonarjs/no-identical-conditions": "error",
      "sonarjs/no-identical-expressions": "error",
      "sonarjs/no-all-duplicated-branches": "error",
      "sonarjs/no-element-overwrite": "error",
      "sonarjs/no-empty-collection": "error",
      "sonarjs/no-gratuitous-expressions": "error",
      "sonarjs/no-collection-size-mischeck": "error",

      // === SONARJS CODE QUALITY (16 RULES) ===
      "sonarjs/no-duplicate-string": ["error", { threshold: 5 }],
      "sonarjs/no-duplicated-branches": "error",
      "sonarjs/no-identical-functions": "error",
      "sonarjs/no-redundant-boolean": "error",
      "sonarjs/no-unused-collection": "error",
      "sonarjs/no-useless-catch": "error",
      "sonarjs/no-collapsible-if": "error",
      "sonarjs/no-redundant-jump": "error",
      "sonarjs/no-nested-template-literals": "error",
      "sonarjs/no-nested-switch": "error",
      "sonarjs/no-small-switch": "error",
      "sonarjs/no-redundant-assignments": "error",
      "sonarjs/prefer-while": "error",
      "sonarjs/prefer-immediate-return": "error",
      "sonarjs/prefer-object-literal": "error",
      "sonarjs/prefer-single-boolean-return": "error",
      "sonarjs/cognitive-complexity": ["error", 25],

      // === COMPLEXITY (7 RULES) ===
      "max-lines": [
        "error",
        { max: 500, skipBlankLines: true, skipComments: true },
      ],
      "max-lines-per-function": ["error", 150],
      "max-statements": ["error", 25],
      "max-params": ["error", 4],
      "max-depth": ["error", 4],
      complexity: ["error", 15],
      "max-nested-callbacks": ["error", 3],

      // === ESLINT 10 RECOMMENDED ===
      "no-unassigned-vars": "error",
      "no-useless-assignment": "error",
      "preserve-caught-error": "error",

      // === ANTI-PATTERN RULES ===
      "no-var": "error",
      "prefer-const": "error",
      "no-debugger": "error",
      "no-eval": "error",
      "no-unreachable": "error",
      "no-new-func": "error",
      "no-void": "error",
      radix: "error",
      "no-throw-literal": "error",
      "no-unmodified-loop-condition": "error",
      "no-proto": "error",
      "no-caller": "error",
      "no-extend-native": "error",
      "no-with": "error",
      "no-iterator": "error",
      "no-labels": "error",
      "no-lone-blocks": "error",
      "no-multi-str": "error",
      "no-octal-escape": "error",
      "no-self-compare": "error",
      yoda: "error",
      "no-implicit-globals": "error",
      "no-global-assign": "error",
      "no-shadow-restricted-names": "error",
      "no-delete-var": "error",
      "no-label-var": "error",
      "no-constructor-return": "error",
      "no-promise-executor-return": "error",
      "no-unsafe-optional-chaining": "error",
      "no-useless-backreference": "error",
      "require-atomic-updates": "error",
      "no-async-promise-executor": "error",
      "prefer-promise-reject-errors": "error",
      "no-nested-ternary": "error",
      "no-else-return": "error",
      "no-magic-numbers": [
        "error",
        { ignore: [0, 1, -1, 2], ignoreArrayIndexes: true },
      ],

      // === PERFORMANCE ===
      "no-new-object": "error",
      "no-new-wrappers": "error",
      "no-array-constructor": "error",
      "no-extra-bind": "error",
      "no-useless-call": "error",
      "no-useless-concat": "error",
      "no-useless-return": "error",
      "prefer-numeric-literals": "error",
      "prefer-exponentiation-operator": "error",
      "prefer-rest-params": "error",
      "prefer-spread": "error",
      "no-useless-escape": "error",
      "prefer-regex-literals": "error",
      "prefer-object-spread": "error",
      "no-lonely-if": "error",
      "prefer-template": "error",
      "no-useless-computed-key": "error",

      // === ENHANCED QUALITY ===
      "@typescript-eslint/no-empty-interface": "error",
      "@typescript-eslint/no-empty-function": ["error", { allow: [] }],
      "no-underscore-dangle": [
        "error",
        {
          allow: [],
          allowAfterThis: false,
          allowAfterSuper: false,
          allowFunctionParams: false,
          enforceInMethodNames: true,
        },
      ],
      "array-callback-return": ["error", { allowImplicit: false }],
      "consistent-return": "error",
      "object-shorthand": ["error", "always"],
      "no-implicit-coercion": "error",
      "grouped-accessor-pairs": ["error", "getBeforeSet"],

      // === CUSTOM RULES ===
      "custom-comments/no-multiline-comments": "error",
      "custom-placeholder/no-placeholder-code": "error",
    },
  },
];

export default eslintConfig;
