import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagesDir = fileURLToPath(new URL('../../packages/', import.meta.url));
const packageDirs = readdirSync(packagesDir)
  .filter((name) => existsSync(resolve(packagesDir, name, 'package.json')))
  .map((name) => resolve(packagesDir, name));
const lit = (node) => (node?.type === 'Literal' ? node.value : undefined);

const packageFence = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    const own = packageDirs.find((dir) => context.filename.startsWith(`${dir}${sep}`));
    if (!own) return {};
    const check = (node, spec) => {
      if (typeof spec !== 'string' || !/^\.\.?(?:[/\\]|$)/.test(spec)) return;
      const target = resolve(dirname(context.filename), spec);
      if (target !== own && !target.startsWith(`${own}${sep}`))
        context.report({ node, message: 'Use the package name for imports outside this package.' });
    };
    return {
      ImportDeclaration: (node) => check(node, node.source.value),
      ExportNamedDeclaration: (node) => node.source && check(node, node.source.value),
      ExportAllDeclaration: (node) => check(node, node.source.value),
      ImportExpression: (node) => check(node, lit(node.source)),
      TSImportType: (node) => check(node, node.source.value),
      CallExpression(node) {
        const callee = node.callee;
        const isResolve = !callee.computed && callee.object?.name === 'require' && callee.property?.name === 'resolve';
        if (callee.name === 'require' || isResolve) check(node, lit(node.arguments[0]));
      },
      NewExpression(node) {
        const base = node.arguments[1];
        if (
          node.callee.name === 'URL' &&
          !base?.computed &&
          base?.property?.name === 'url' &&
          base.object?.meta?.name === 'import'
        )
          check(node, lit(node.arguments[0]));
      },
    };
  },
};

const directive = /^\s*(?:eslint|oxlint)-disable(?:-next-line|-line)?(?=\s|$)(.*)$/s;
const reasoned = /^\s+[^\s-].*?\s-{2,}\s+\S/s;

const directiveReason = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const match = directive.exec(comment.value);
          if (match && !reasoned.test(match[1]))
            context.report({ node: comment, message: 'Name the disabled rule and give a reason after `--`.' });
        }
      },
    };
  },
};

const fileSnapshots = new Set(['toMatchSnapshot', 'toMatchFileSnapshot', 'toThrowErrorMatchingSnapshot']);
const inlineSnapshots = new Set(['toMatchInlineSnapshot', 'toThrowErrorMatchingInlineSnapshot']);
const inlineLines = 20;

const noSnapshot = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    return {
      CallExpression(node) {
        const name = node.callee.type === 'MemberExpression' ? node.callee.property.name : undefined;
        if (fileSnapshots.has(name)) {
          context.report({ node, message: 'Assert the values the test protects instead of a file snapshot.' });
        } else if (inlineSnapshots.has(name)) {
          const text = node.arguments.map((arg) => context.sourceCode.getText(arg)).join('\n');
          if (text.split('\n').length > inlineLines)
            context.report({ node, message: `Keep inline snapshots to ${inlineLines} lines or fewer.` });
        }
      },
    };
  },
};

const exemptCodes = /^STIM_(?:BAD_ARG|CANCELLED|CI_CANCELLED)$/;
const keyName = (property) => property.key?.name ?? property.key?.value;
const unwrap = (node) =>
  node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' ? unwrap(node.expression) : node;

const refusalRemedy = {
  meta: { type: 'suggestion', schema: [] },
  create(context) {
    return {
      ObjectExpression(node) {
        if (node.parent.type === 'CallExpression' && node.parent.callee.property?.name === 'emitWarning') return;
        const code = node.properties.find((p) => p.type === 'Property' && keyName(p) === 'code');
        const value = code && unwrap(code.value);
        if (value?.type !== 'Literal' || typeof value.value !== 'string' || !value.value.startsWith('STIM_')) return;
        if (exemptCodes.test(value.value)) return;
        if (node.properties.some((p) => p.type === 'SpreadElement' || ['remedy', 'diagnostics'].includes(keyName(p))))
          return;
        context.report({ node, message: `${value.value} needs a remedy that says how to recover.` });
      },
    };
  },
};

export default {
  meta: { name: 'stim' },
  rules: {
    'package-fence': packageFence,
    'directive-reason': directiveReason,
    'no-snapshot': noSnapshot,
    'refusal-remedy': refusalRemedy,
  },
};
