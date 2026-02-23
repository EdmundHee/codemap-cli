import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

interface FrameworkSignal {
  name: string;
  detect: (root: string) => boolean;
}

const FRAMEWORK_SIGNALS: FrameworkSignal[] = [
  {
    name: 'express',
    detect: (root) => hasDependency(root, 'express') && !hasDependency(root, '@nestjs/core'),
  },
  {
    name: 'nestjs',
    detect: (root) => hasDependency(root, '@nestjs/core'),
  },
  {
    name: 'fastapi',
    detect: (root) => hasPythonDependency(root, 'fastapi'),
  },
  {
    name: 'django',
    detect: (root) => hasPythonDependency(root, 'django') || existsSync(join(root, 'manage.py')),
  },
  {
    name: 'flask',
    detect: (root) => hasPythonDependency(root, 'flask'),
  },
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
];

/**
 * Auto-detect frameworks used in the project by scanning config files.
 */
export async function detectFrameworks(root: string): Promise<string[]> {
  const detected: string[] = [];

  for (const signal of FRAMEWORK_SIGNALS) {
    try {
      if (signal.detect(root)) {
        detected.push(signal.name);
      }
    } catch {
      // Ignore detection errors for individual frameworks
    }
  }

  return detected;
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
