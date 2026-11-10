// oxlint-disable no-console
import Type from 'typebox';

import {
  RUSSET_EXTENSION_API_VERSION,
  defineRuntimeTool,
} from '@russet/runtime';

import { parseExampleOptions, runLiveExample } from './shared.mjs';

const options = parseExampleOptions(process.argv.slice(2));

function createExampleExtensions({ workspace, policy }) {
  return [
    {
      id: 'example.workspace',
      apiVersion: RUSSET_EXTENSION_API_VERSION,

      activate(context) {
        console.log('[Extension] Activating example.workspace');

        context.registerTool(
          defineRuntimeTool({
            name: 'workspace_info',

            description:
              'Report the selected workspace root and effective ' +
              'operating mode. No arguments are required.',

            action: 'fs.search',
            failureSideEffects: 'none',

            parameters: Type.Object({}, { additionalProperties: false }),

            target() {
              return {
                path: '.',
                expectation: 'existing',
              };
            },

            execute(_args, execution) {
              if (execution.resource.kind !== 'directory') {
                throw new Error('Expected the workspace root directory.');
              }

              console.log('[Extension] Executing workspace_info');

              return JSON.stringify(
                {
                  workspaceRoot: workspace.rootPath,
                  mode: policy.mode,
                  resolvedResource: execution.resource.relativePath,
                },
                null,
                2,
              );
            },
          }),
        );
      },

      deactivate() {
        console.log('[Extension] Deactivating example.workspace');
      },
    },
  ];
}

const message = [
  'Inspect the active Runtime environment.',
  'Use workspace_info to identify the workspace and operating mode.',
  'Use the available filesystem tools if additional project context is useful.',
  'Explain the information obtained from the tool results.',
  'Do not modify files.',
].join(' ');

runLiveExample({
  options,
  message,

  extensionFactory: createExampleExtensions,

  requiredSuccessfulTools: ['workspace_info'],
}).catch((error) => {
  console.error(
    '\n[Extension example failed]',
    error instanceof Error ? error.message : String(error),
  );

  process.exitCode = 1;
});
