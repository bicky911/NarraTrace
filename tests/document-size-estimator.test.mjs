import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const startMarker = '  function estimateDocumentCloneBytes(root, maxBytes) {';
const endMarker = '  /**\n   * Find the best set of article elements';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
assert.ok(start >= 0 && end > start, 'production document-size estimator should be present');

const helperSource = source.slice(start, end).trim();
const sandbox = {};
vm.runInNewContext(
  helperSource + '\nglobalThis.__estimateDocumentCloneBytes = estimateDocumentCloneBytes;',
  sandbox,
  { filename: 'content.js#estimateDocumentCloneBytes' }
);
const estimateDocumentCloneBytes = sandbox.__estimateDocumentCloneBytes;

function makeRoot(children = [], extraTrees = new Map()) {
  let nextCalls = 0;
  let walkerCreations = 0;
  const root = {
    nodeType: 1,
    tagName: 'HTML',
    attributes: [{ name: 'lang', value: 'en' }]
  };
  Object.defineProperty(root, 'outerHTML', {
    get() {
      throw new Error('outerHTML must not be serialized to estimate clone size');
    }
  });
  root.ownerDocument = {
    createTreeWalker(walkRoot, whatToShow) {
      assert.ok(walkRoot === root || extraTrees.has(walkRoot));
      assert.equal(whatToShow, 0xFFFFFFFF);
      walkerCreations++;
      const nodes = walkRoot === root ? children : extraTrees.get(walkRoot);
      let index = 0;
      return {
        nextNode() {
          nextCalls++;
          return nodes[index++] || null;
        }
      };
    }
  };
  return {
    root,
    nextCalls: () => nextCalls,
    walkerCreations: () => walkerCreations
  };
}

test('estimates element, attribute, and text-node size without reading outerHTML', () => {
  const paragraph = {
    nodeType: 1,
    tagName: 'P',
    attributes: [{ name: 'class', value: 'body' }]
  };
  const text = { nodeType: 3, nodeValue: 'hello' };
  const { root } = makeRoot([paragraph, text]);

  assert.equal(estimateDocumentCloneBytes(root, 10000), 242);
});

test('stops walking as soon as the configured clone budget is exceeded', () => {
  const laterNode = {};
  Object.defineProperty(laterNode, 'nodeType', {
    get() {
      throw new Error('nodes after the budget must not be visited');
    }
  });
  const { root, nextCalls } = makeRoot([
    { nodeType: 3, nodeValue: 'x'.repeat(200) },
    laterNode
  ]);

  const estimate = estimateDocumentCloneBytes(root, 100);
  assert.ok(estimate > 100);
  assert.equal(nextCalls(), 1, 'the walker must stop immediately after crossing the budget');
});

test('includes detached template contents in the clone estimate', () => {
  const templateContent = { nodeType: 11 };
  const template = {
    nodeType: 1,
    tagName: 'TEMPLATE',
    attributes: [],
    content: templateContent
  };
  const templateText = { nodeType: 3, nodeValue: 'hidden' };
  const { root, walkerCreations } = makeRoot(
    [template],
    new Map([[templateContent, [templateText]]])
  );

  assert.equal(estimateDocumentCloneBytes(root, 10000), 256);
  assert.equal(walkerCreations(), 2, 'template content must be traversed separately');
});

test('invalid roots and unavailable DOM traversal fail safely', () => {
  assert.equal(estimateDocumentCloneBytes(null, 100), 0);
  assert.equal(estimateDocumentCloneBytes({ nodeType: 1, tagName: 'DIV', attributes: [] }, 100), Infinity);
});
