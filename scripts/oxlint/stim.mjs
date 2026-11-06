const directive = /^\s*(?:eslint|oxlint)-disable(?:-next-line|-line)?(?=\s|$)(.*)$/s;
const reasoned = /^\s+[^\s-].*?\s--\s+\S/s;

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
            context.report({ node, message: `Keep inline snapshots under ${inlineLines} lines.` });
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
  rules: { 'directive-reason': directiveReason, 'no-snapshot': noSnapshot, 'refusal-remedy': refusalRemedy },
};
