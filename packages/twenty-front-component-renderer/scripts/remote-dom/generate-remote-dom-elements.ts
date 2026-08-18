import * as prettier from '@prettier/sync';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { IndentationText, Project, QuoteKind } from 'ts-morph';
import { fileURLToPath } from 'url';

import { ALLOWED_HTML_ELEMENTS } from '../../src/constants/AllowedHtmlElements';
import { COMMON_HTML_EVENTS } from '../../src/constants/CommonHtmlEvents';
import { HTML_COMMON_PROPERTIES } from '../../src/constants/HtmlCommonProperties';

import {
  type ComponentSchema,
  generateHostRegistry,
  generateRemoteComponents,
  generateRemoteElements,
  HtmlElementConfigArrayZ,
  OUTPUT_FILES,
} from './generators';

// Nx sets FORCE_COLOR for child commands. Under Node 24, @prettier/sync can
// stall while starting its esbuild worker in that environment. Formatting does
// not need color, so restart once without it before loading the generator.
if (process.env.FORCE_COLOR && !process.env.TWENTY_REMOTE_DOM_REEXEC) {
  const { FORCE_COLOR: _forceColor, ...env } = process.env;
  const result = spawnSync(
    process.execPath,
    [...process.execArgv, ...process.argv.slice(1)],
    {
      env: { ...env, TWENTY_REMOTE_DOM_REEXEC: '1' },
      stdio: 'inherit',
    },
  );

  process.exit(result.status ?? 1);
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_PATH = path.resolve(SCRIPT_DIR, '../..');
const SRC_PATH = path.join(PACKAGE_PATH, 'src');
const HOST_GENERATED_DIR = path.join(SRC_PATH, 'host/generated');
const REMOTE_GENERATED_DIR = path.join(SRC_PATH, 'remote/generated');

const extractHtmlTag = (tag: string): string => tag.slice(5);

const getHtmlElementSchemas = (): ComponentSchema[] => {
  const result = HtmlElementConfigArrayZ.safeParse(ALLOWED_HTML_ELEMENTS);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid HTML element configuration:\n${details}`);
  }

  return result.data.map((element) => ({
    name: element.name,
    customElementName: element.tag,
    properties: {
      ...HTML_COMMON_PROPERTIES,
      ...element.properties,
    },
    events: element.events
      ? [...COMMON_HTML_EVENTS, ...element.events]
      : COMMON_HTML_EVENTS,
    htmlTag: element.htmlTag ?? extractHtmlTag(element.tag),
  }));
};

const getUtilityComponentSchemas = (): ComponentSchema[] => [
  {
    name: 'RemoteStyle',
    customElementName: 'remote-style',
    properties: {
      cssText: { type: 'string', optional: true },
      styleKey: { type: 'string', optional: true },
    },
    events: [],
    customHostRenderer: 'RemoteStyleRenderer',
    customHostRendererPath: '@/host/components/RemoteStyleRenderer',
  },
];

const writeGeneratedFile = (
  dir: string,
  filename: string,
  content: string,
): void => {
  const filePath = path.join(dir, filename);
  const formattedContent = prettier.format(content, {
    parser: 'typescript',
    filepath: filePath,
    singleQuote: true,
    trailingComma: 'all',
    endOfLine: 'lf',
  });
  fs.writeFileSync(filePath, formattedContent, 'utf-8');
};

const main = (): void => {
  const htmlElements = getHtmlElementSchemas();
  const utilityComponents = getUtilityComponentSchemas();
  const allComponents = [...htmlElements, ...utilityComponents];

  fs.mkdirSync(HOST_GENERATED_DIR, { recursive: true });
  fs.mkdirSync(REMOTE_GENERATED_DIR, { recursive: true });

  const project = new Project({
    manipulationSettings: {
      indentationText: IndentationText.TwoSpaces,
      quoteKind: QuoteKind.Single,
      useTrailingCommas: true,
    },
  });

  const hostRegistry = generateHostRegistry(project, allComponents);
  writeGeneratedFile(
    HOST_GENERATED_DIR,
    OUTPUT_FILES.HOST_REGISTRY,
    hostRegistry.getFullText(),
  );

  const remoteElements = generateRemoteElements(
    project,
    allComponents,
    HTML_COMMON_PROPERTIES,
    COMMON_HTML_EVENTS,
  );
  writeGeneratedFile(
    REMOTE_GENERATED_DIR,
    OUTPUT_FILES.REMOTE_ELEMENTS,
    remoteElements.getFullText(),
  );

  const remoteComponents = generateRemoteComponents(project, allComponents);
  writeGeneratedFile(
    REMOTE_GENERATED_DIR,
    OUTPUT_FILES.REMOTE_COMPONENTS,
    remoteComponents.getFullText(),
  );
};

main();
