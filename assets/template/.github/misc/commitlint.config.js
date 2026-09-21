// Commit gate rules; headerPattern must stay identical to .releaserc.json parserOpts
//
// Form: <type>(<emoji|scope>)?!?: <description>  e.g. feat(:fire:): cross-compile support
//
// Emoji semantics (CI triggers): see .github/skills/_shared/gitmoji.md
module.exports = {
  parserPreset: {
    parserOpts: {
      headerPattern: /^(\w*)(?:\(([^)]*)\))?!?: (.*)$/,
      headerCorrespondence: ['type', 'scope', 'subject'],
    },
  },
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'perf', 'docs', 'test', 'build', 'ci', 'refactor', 'style', 'chore'],
    ],
    'type-case': [2, 'always', 'lower-case'],
    'type-empty': [2, 'never'],
    'subject-empty': [2, 'never'],
    'subject-max-length': [2, 'always', 100],
    'header-max-length': [2, 'always', 120],
  },
};
