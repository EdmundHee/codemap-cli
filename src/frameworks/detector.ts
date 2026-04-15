import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

interface FrameworkSignal {
  name: string;
  detect: (root: string) => boolean;
}

const FRAMEWORK_SIGNALS: FrameworkSignal[] = [
  // ── JavaScript/TypeScript frameworks ──
  {
    name: 'nuxt',
    detect: (root) =>
      hasDependency(root, 'nuxt') ||
      existsSync(join(root, 'nuxt.config.ts')) ||
      existsSync(join(root, 'nuxt.config.js')),
  },
  {
    name: 'next',
    detect: (root) => hasDependency(root, 'next'),
  },
  {
    name: 'express',
    detect: (root) => hasDependency(root, 'express') && !hasDependency(root, '@nestjs/core'),
  },
  {
    name: 'nestjs',
    detect: (root) => hasDependency(root, '@nestjs/core'),
  },
  {
    name: 'vue',
    detect: (root) =>
      hasDependency(root, 'vue') && !hasDependency(root, 'nuxt'),
  },
  {
    name: 'react',
    detect: (root) =>
      hasDependency(root, 'react') && !hasDependency(root, 'next'),
  },
  // ── Python frameworks ──
  {
    name: 'django',
    detect: (root) => hasPythonDependency(root, 'django') || existsSync(join(root, 'manage.py')),
  },
  {
    name: 'django-rest-framework',
    detect: (root) => hasPythonDependency(root, 'djangorestframework'),
  },
  {
    name: 'fastapi',
    detect: (root) => hasPythonDependency(root, 'fastapi'),
  },
  {
    name: 'flask',
    detect: (root) => hasPythonDependency(root, 'flask'),
  },
  {
    name: 'pydantic',
    detect: (root) =>
      hasPythonDependency(root, 'pydantic') &&
      !hasPythonDependency(root, 'fastapi'),
  },
  // ── ORMs and databases ──
  {
    name: 'prisma',
    detect: (root) => existsSync(join(root, 'prisma', 'schema.prisma')),
  },
  {
    name: 'sequelize',
    detect: (root) => hasDependency(root, 'sequelize'),
  },
  {
    name: 'mongoose',
    detect: (root) => hasDependency(root, 'mongoose'),
  },
  {
    name: 'typeorm',
    detect: (root) => hasDependency(root, 'typeorm'),
  },
  {
    name: 'sqlalchemy',
    detect: (root) => hasPythonDependency(root, 'sqlalchemy'),
  },
  // ── State management ──
  {
    name: 'pinia',
    detect: (root) => hasDependency(root, 'pinia'),
  },
  // ── Task queues & testing ──
  {
    name: 'celery',
    detect: (root) => hasPythonDependency(root, 'celery'),
  },
  {
    name: 'pytest',
    detect: (root) => hasPythonDependency(root, 'pytest'),
  },
  {
    name: 'langgraph',
    detect: (root) => hasPythonDependency(root, 'langgraph'),
  },
];

/** Directories to skip when scanning for monorepo subdirectories */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'venv', '.venv', 'env', '.env', '__pycache__', 'coverage',
  '.codemap', '.tox', 'eggs', 'site-packages', 'vendor', 'lib',
]);

/** Scan a single root for frameworks */
function scanRoot(root: string, detected: Set<string>): void {
  for (const signal of FRAMEWORK_SIGNALS) {
    try {
      if (signal.detect(root)) {
        detected.add(signal.name);
      }
    } catch {
      // Ignore detection errors for individual frameworks
    }
  }
}

/** Check if a directory has its own dependency file */
function hasAnyDependencyFile(dir: string): boolean {
  return (
    existsSync(join(dir, 'package.json')) ||
    existsSync(join(dir, 'requirements.txt')) ||
    existsSync(join(dir, 'pyproject.toml'))
  );
}

/**
 * Auto-detect frameworks used in the project by scanning config files.
 * Also scans immediate subdirectories for monorepo support.
 */
export async function detectFrameworks(root: string): Promise<string[]> {
  const detected = new Set<string>();

  // Scan project root
  scanRoot(root, detected);

  // Scan immediate subdirectories for monorepo packages
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const subRoot = join(root, entry.name);
      if (hasAnyDependencyFile(subRoot)) {
        scanRoot(subRoot, detected);
      }
    }
  } catch {
    // Ignore errors reading subdirectories
  }

  return [...detected];
}

/** Check if a Node.js project has a dependency in package.json */
function hasDependency(root: string, pkg: string): boolean {
  const pkgJsonPath = join(root, 'package.json');
  if (!existsSync(pkgJsonPath)) return false;

  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    return !!(
      pkgJson.dependencies?.[pkg] ||
      pkgJson.devDependencies?.[pkg] ||
      pkgJson.peerDependencies?.[pkg]
    );
  } catch {
    return false;
  }
}

/** Check if a Python project has a dependency */
function hasPythonDependency(root: string, pkg: string): boolean {
  // Check requirements.txt
  const reqPath = join(root, 'requirements.txt');
  if (existsSync(reqPath)) {
    const content = readFileSync(reqPath, 'utf-8').toLowerCase();
    if (content.includes(pkg.toLowerCase())) return true;
  }

  // Check pyproject.toml
  const pyprojectPath = join(root, 'pyproject.toml');
  if (existsSync(pyprojectPath)) {
    const content = readFileSync(pyprojectPath, 'utf-8').toLowerCase();
    if (content.includes(pkg.toLowerCase())) return true;
  }

  // Check setup.py
  const setupPath = join(root, 'setup.py');
  if (existsSync(setupPath)) {
    const content = readFileSync(setupPath, 'utf-8').toLowerCase();
    if (content.includes(pkg.toLowerCase())) return true;
  }

  return false;
}
