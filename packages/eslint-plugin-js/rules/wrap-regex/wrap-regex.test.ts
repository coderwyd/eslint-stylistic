/**
 * @fileoverview Tests for wrap-regex rule.
 * @author Nicholas C. Zakas
 */

import { RuleTester } from 'eslint'
import rule from './wrap-regex'

// ------------------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------------------

const ruleTester = new RuleTester()

ruleTester.run('wrap-regex', rule, {
  valid: [
    '(/foo/).test(bar);',
    '(/foo/ig).test(bar);',
    '/foo/;',
    'var f = 0;',
    'a[/b/];',
  ],
  invalid: [
    {
      code: '/foo/.test(bar);',
      output: '(/foo/).test(bar);',
      errors: [{ messageId: 'requireParens', type: 'Literal' }],
    },
    {
      code: '/foo/ig.test(bar);',
      output: '(/foo/ig).test(bar);',
      errors: [{ messageId: 'requireParens', type: 'Literal' }],
    },

    // https://github.com/eslint/eslint/issues/10573
    {
      code: 'if(/foo/ig.test(bar));',
      output: 'if((/foo/ig).test(bar));',
      errors: [{ messageId: 'requireParens', type: 'Literal' }],
    },
  ],
})
