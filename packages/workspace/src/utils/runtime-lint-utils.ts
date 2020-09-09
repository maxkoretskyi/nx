import { normalize } from '@angular-devkit/core';
import * as path from 'path';
import { FileData } from '../core/file-utils';
import {
  DependencyType,
  ProjectGraph,
  ProjectGraphDependency,
  ProjectGraphNode,
} from '../core/project-graph';
import { TargetProjectLocator } from '../core/target-project-locator';

export type Deps = { [projectName: string]: ProjectGraphDependency[] };
export type DepConstraint = {
  sourceTag: string;
  onlyDependOnLibsWithTags: string[];
};

export function hasNoneOfTheseTags(proj: ProjectGraphNode, tags: string[]) {
  return tags.filter((allowedTag) => hasTag(proj, allowedTag)).length === 0;
}

function hasTag(proj: ProjectGraphNode, tag: string) {
  return (proj.data.tags || []).indexOf(tag) > -1 || tag === '*';
}

function containsFile(
  files: FileData[],
  targetFileWithoutExtension: string
): boolean {
  return !!files.filter(
    (f) => removeExt(f.file) === targetFileWithoutExtension
  )[0];
}

function removeExt(file: string): string {
  return file.replace(/\.[^/.]+$/, '');
}

function removeWindowsDriveLetter(osSpecificPath: string): string {
  return osSpecificPath.replace(/^[A-Z]:/, '');
}

function normalizePath(osSpecificPath: string): string {
  return removeWindowsDriveLetter(osSpecificPath).split(path.sep).join('/');
}

export function matchImportWithWildcard(
  // This may or may not contain wildcards ("*")
  allowableImport: string,
  extractedImport: string
): boolean {
  if (allowableImport.endsWith('/**')) {
    const prefix = allowableImport.substring(0, allowableImport.length - 2);
    return extractedImport.startsWith(prefix);
  } else if (allowableImport.endsWith('/*')) {
    const prefix = allowableImport.substring(0, allowableImport.length - 1);
    if (!extractedImport.startsWith(prefix)) return false;
    return extractedImport.substring(prefix.length).indexOf('/') === -1;
  } else if (allowableImport.indexOf('/**/') > -1) {
    const [prefix, suffix] = allowableImport.split('/**/');
    return (
      extractedImport.startsWith(prefix) && extractedImport.endsWith(suffix)
    );
  } else {
    return new RegExp(allowableImport).test(extractedImport);
  }
}

export function isRelative(s: string) {
  return s.startsWith('.');
}

export function isRelativeImportIntoAnotherProject(
  imp: string,
  projectPath: string,
  projectGraph: ProjectGraph,
  sourceFilePath: string
): boolean {
  if (!isRelative(imp)) return false;

  const targetFile = normalizePath(
    path.resolve(path.join(projectPath, path.dirname(sourceFilePath)), imp)
  ).substring(projectPath.length + 1);

  const sourceProject = findSourceProject(projectGraph, sourceFilePath);
  const targetProject = findTargetProject(projectGraph, targetFile);
  return sourceProject && targetProject && sourceProject !== targetProject;
}

export function findProjectUsingFile(projectGraph: ProjectGraph, file: string) {
  return Object.values(projectGraph.nodes).filter((n) =>
    containsFile(n.data.files, file)
  )[0];
}

export function findSourceProject(
  projectGraph: ProjectGraph,
  sourceFilePath: string
) {
  const targetFile = removeExt(sourceFilePath);
  return findProjectUsingFile(projectGraph, targetFile);
}

export function findTargetProject(
  projectGraph: ProjectGraph,
  targetFile: string
) {
  let targetProject = findProjectUsingFile(projectGraph, targetFile);
  if (!targetProject) {
    targetProject = findProjectUsingFile(
      projectGraph,
      normalizePath(path.join(targetFile, 'index'))
    );
  }
  if (!targetProject) {
    targetProject = findProjectUsingFile(
      projectGraph,
      normalizePath(path.join(targetFile, 'src', 'index'))
    );
  }
  return targetProject;
}

export function isAbsoluteImportIntoAnotherProject(imp: string) {
  // TODO: vsavkin: check if this needs to be fixed once we generalize lint rules
  return (
    imp.startsWith('libs/') ||
    imp.startsWith('/libs/') ||
    imp.startsWith('apps/') ||
    imp.startsWith('/apps/')
  );
}

export function findProjectUsingImport(
  projectGraph: ProjectGraph,
  targetProjectLocator: TargetProjectLocator,
  filePath: string,
  imp: string,
  npmScope: string
) {
  const target = targetProjectLocator.findProjectWithImport(
    imp,
    filePath,
    npmScope
  );
  return projectGraph.nodes[target];
}

export function checkCircularPath(
  graph: ProjectGraph,
  sourceProject: ProjectGraphNode,
  targetProject: ProjectGraphNode
): Array<any> {
  if (!graph.nodes[targetProject.name]) return [];
  return getPath(graph, targetProject.name, sourceProject.name);
}

let reach = {
  graph: null,
  matrix: null,
  nameToIndexMap: {},
  indexToNameMap: {},
  adjList: null
};

function buildMatrix(graph) {
  const dependencies = graph.dependencies;
  const nodes = Object.keys(graph.nodes).filter(s => !s.includes('npm:'));
  const nameToIndexMap = {};
  const indexToNameMap = {};
  const adjList = new Array(nodes.length);
  const matrix = new Array(nodes.length);

  nodes.forEach((value, index) => {
    nameToIndexMap[value] = index;
    indexToNameMap[index] = value;
  });

  for (let i = 0; i < nodes.length; i++) {
    adjList[i] = [];
    matrix[i] = new Array(nodes.length).fill(0);
  }

  for (let proj in dependencies) {
    const u = nameToIndexMap[proj];
    for (let dep of dependencies[proj]) {
      const v = nameToIndexMap[dep.target];
      if (v !== undefined) {
        adjList[u].push(v);
      }
    }
  }

  const traverse = (s, v) => {
    matrix[s][v] = 1;

    for (let adj of adjList[v]) {
      if (matrix[s][adj] === 0) {
        traverse(s, adj);
      }
    }
  };

  for (let i = 0; i < nodes.length; i++) {
    traverse(i, i);
  }

  return {
    matrix,
    nameToIndexMap,
    indexToNameMap,
    adjList,
  };
}

function getPath(graph, sourceProjectName, targetProjectName) {
  if (reach.graph !== graph) {
    const result = buildMatrix(graph);
    reach.matrix = result.matrix;
    reach.nameToIndexMap = result.nameToIndexMap;
    reach.indexToNameMap = result.indexToNameMap;
    reach.graph = graph;
    reach.adjList = result.adjList;
  }

  const adjList = reach.adjList;
  const path = [];
  if (sourceProjectName === targetProjectName) return path;

  const src = reach.nameToIndexMap[sourceProjectName];
  const dest = reach.nameToIndexMap[targetProjectName];

  let next = src;

  while (next !== null) {
    if (next === dest) break;

    let current = next;
    next = null;

    for (let adj of adjList[current]) {
      if (reach.matrix[adj][dest] === 1) {
        path.push(adj);
        next = adj;
        break;
      }
    }
  }

  const mapped = path.map((i) => reach.indexToNameMap[i]);

  if (mapped.length > 0) {
    mapped.unshift(sourceProjectName);
  }

  return mapped;
}

export function findConstraintsFor(
  depConstraints: DepConstraint[],
  sourceProject: ProjectGraphNode
) {
  return depConstraints.filter((f) => hasTag(sourceProject, f.sourceTag));
}

export function onlyLoadChildren(
  graph: ProjectGraph,
  sourceProjectName: string,
  targetProjectName: string,
  visited: string[]
) {
  if (visited.indexOf(sourceProjectName) > -1) return false;
  return (
    (graph.dependencies[sourceProjectName] || []).filter((d) => {
      if (d.type !== DependencyType.dynamic) return false;
      if (d.target === targetProjectName) return true;
      return onlyLoadChildren(graph, d.target, targetProjectName, [
        ...visited,
        sourceProjectName,
      ]);
    }).length > 0
  );
}

export function getSourceFilePath(sourceFileName: string, projectPath: string) {
  return normalize(sourceFileName).substring(projectPath.length + 1);
}

/**
 * Verifies whether the given node has an architect builder attached
 * @param projectGraph the node to verify
 */
export function hasArchitectBuildBuilder(
  projectGraph: ProjectGraphNode
): boolean {
  return (
    // can the architect not be defined? real use case?
    projectGraph.data.architect &&
    projectGraph.data.architect.build &&
    projectGraph.data.architect.build.builder !== ''
  );
}
