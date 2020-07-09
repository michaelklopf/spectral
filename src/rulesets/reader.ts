import { join, extname } from '@stoplight/path';
import { Optional } from '@stoplight/types';
import { parse } from '@stoplight/yaml';
import { readFile, readParsable } from '../fs/reader';
import type { IHttpAndFileResolverOptions } from '../resolvers/http-and-file';
import { FileRulesetSeverity, IRuleset, RulesetFunctionCollection } from '../types/ruleset';
import { findFile, isNPMSource } from './finder';
import { mergeFormats, mergeFunctions, mergeRules } from './mergers';
import { mergeExceptions } from './mergers/exceptions';
import generate, { Dependencies, ModuleRegistry } from 'json-ref-escodegen';
const createArray = require('json-ref-escodegen/runtime/create-array.cjs');
import * as path from '@stoplight/path';
import { assertValidRuleset } from './validation';

export interface IRulesetReadOptions extends IHttpAndFileResolverOptions {
  timeout?: number;
}

function parseContent(content: string, source: string): unknown {
  if (extname(source) === '.json') {
    return JSON.parse(content);
  }

  return parse(content);
}

export async function readRuleset(uris: string | string[], opts?: IRulesetReadOptions): Promise<IRuleset> {
  const base: IRuleset = {
    rules: {},
    functions: {},
    exceptions: {},
  };

  const processedRulesets = new Set<string>();
  const processRuleset = createRulesetProcessor(processedRulesets, opts);

  for (const uri of Array.isArray(uris) ? new Set([...uris]) : [uris]) {
    processedRulesets.clear(); // makes sure each separate ruleset starts with clear list
    const resolvedRuleset = await processRuleset(uri, uri);
    if (resolvedRuleset === null) continue;
    Object.assign(base.rules, resolvedRuleset.rules);
    Object.assign(base.functions, resolvedRuleset.functions);
    Object.assign(base.exceptions, resolvedRuleset.exceptions);
  }

  return base;
}

const createRulesetProcessor = (processedRulesets: Set<string>, readOpts: Optional<IRulesetReadOptions>) => {
  return async function processRuleset(
    baseUri: string,
    uri: string,
    severity?: FileRulesetSeverity,
  ): Promise<IRuleset | null> {
    const rulesetUri = await findFile(join(baseUri, '..'), uri);
    if (processedRulesets.has(rulesetUri)) {
      return null;
    }

    const output = {};
    processedRulesets.add(rulesetUri);
    const { id } = await generate(rulesetUri, {
      module: 'cjs',
      fs: {
        read: async source => {
          const content = await readParsable(source, {
            timeout: readOpts?.timeout,
            encoding: 'utf8',
            agent: readOpts?.agent,
          });

          if (!source.endsWith('oas/schemas/schema.oas2.json') && !source.endsWith('oas/schemas/schema.oas3.json')) {
            return parseContent(content, source);
          }

          return content;
        },
        async write(target, content): Promise<void> {
          output[target] = content;
        },
      },
      shouldResolve(source): boolean {
        return !source.endsWith('oas/schemas/schema.oas2.json') && !source.endsWith('oas/schemas/schema.oas3.json');
      },
      path: path as any,
      dependencies: new Dependencies(),
      moduleRegistry: new ModuleRegistry(),
    });

    const ruleset = assertValidRuleset(createFakeRequire(output)(`./${id}.cjs`));
    const rules = {};
    const functions = {};
    const exceptions = {};
    const newRuleset: IRuleset = {
      rules,
      functions,
      exceptions,
    };

    const extendedRulesets = ruleset.extends;
    const rulesetFunctions = ruleset.functions;

    if (extendedRulesets !== void 0) {
      for (const extended of Array.isArray(extendedRulesets) ? extendedRulesets : [extendedRulesets]) {
        let extendedRuleset: IRuleset | null;
        let parentSeverity: FileRulesetSeverity;
        if (Array.isArray(extended)) {
          parentSeverity = severity === undefined ? extended[1] : severity;
          extendedRuleset = await processRuleset(rulesetUri, extended[0], parentSeverity);
        } else {
          parentSeverity = severity === undefined ? 'recommended' : severity;
          extendedRuleset = await processRuleset(rulesetUri, extended, parentSeverity);
        }

        if (extendedRuleset !== null) {
          mergeRules(rules, extendedRuleset.rules, parentSeverity);
          Object.assign(functions, extendedRuleset.functions);
          mergeExceptions(exceptions, extendedRuleset.exceptions, baseUri);
        }
      }
    }

    if (ruleset.rules !== void 0) {
      mergeRules(rules, ruleset.rules, severity === undefined ? 'recommended' : severity);
    }

    if (ruleset.except !== void 0) {
      mergeExceptions(exceptions, ruleset.except, baseUri);
    }

    if (Array.isArray(ruleset.formats)) {
      mergeFormats(rules, ruleset.formats);
    }

    if (rulesetFunctions !== void 0) {
      const rulesetFunctionsBaseDir = join(
        rulesetUri,
        isNPMSource(rulesetUri) ? '.' : '..',
        ruleset.functionsDir !== void 0 ? ruleset.functionsDir : 'functions',
      );
      const resolvedFunctions: RulesetFunctionCollection = {};

      await Promise.all(
        rulesetFunctions.map(async fn => {
          const fnName = Array.isArray(fn) ? fn[0] : fn;
          const fnSchema = Array.isArray(fn) ? fn[1] : null;
          const source = await findFile(rulesetFunctionsBaseDir, `./${fnName}.js`);

          try {
            resolvedFunctions[fnName] = {
              name: fnName,
              code: await readFile(source, {
                timeout: readOpts?.timeout,
                encoding: 'utf8',
                agent: readOpts?.agent,
              }),
              schema: fnSchema,
              source,
            };
          } catch (ex) {
            console.warn(`Function '${fnName}' could not be loaded: ${ex.message}`);
          }
        }),
      );

      mergeFunctions(functions, resolvedFunctions, rules);
    }

    return newRuleset;
  };
};

function createFakeRequire(availableModules: any) {
  const evaluatedModules = {
    'json-ref-escodegen/runtime/create-array.cjs': createArray,
  };

  return function require(path: string) {
    if (path in evaluatedModules) {
      return evaluatedModules[path];
    } else if (path in availableModules) {
      const module = {
        get exports() {
          return evaluatedModules[path];
        },
        set exports(val) {
          evaluatedModules[path] = val;
        },
      };

      Function('require, module', availableModules[path])(require, module);
      return evaluatedModules[path];
    } else {
      throw new Error(`${path} does not exist`);
    }
  };
}
