import { GoParser } from '../go-parser';
import { ScannedFile } from '../../../core/scanner';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('GoParser', () => {
  let parser: GoParser;
  let tempDir: string;

  beforeAll(() => {
    parser = new GoParser();
    tempDir = join(tmpdir(), 'go-parser-test-' + Date.now());
    mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createGoFile(name: string, content: string): ScannedFile {
    const filePath = join(tempDir, name);
    writeFileSync(filePath, content);
    return { absolute: filePath, relative: name, language: 'go' as any };
  }

  it('parses a struct with fields', async () => {
    const file = createGoFile('model.go', `
package main

type User struct {
    Name  string
    email string
    Age   int
}
`);
    const result = await parser.parse(file);
    expect(result.classes).toHaveLength(1);
    expect(result.classes[0].name).toBe('User');
    expect(result.classes[0].properties).toHaveLength(3);
    // Uppercase = public
    const nameProp = result.classes[0].properties.find(p => p.name === 'Name');
    expect(nameProp?.access).toBe('public');
    // Lowercase = private
    const emailProp = result.classes[0].properties.find(p => p.name === 'email');
    expect(emailProp?.access).toBe('private');
  });

  it('parses package-level functions', async () => {
    const file = createGoFile('funcs.go', `
package main

import "fmt"

func Add(a int, b int) int {
    fmt.Println("adding")
    return a + b
}

func helper() string {
    return "help"
}
`);
    const result = await parser.parse(file);
    expect(result.functions.length).toBeGreaterThanOrEqual(2);
    const addFn = result.functions.find(f => f.name === 'Add');
    expect(addFn).toBeDefined();
    expect(addFn!.params).toHaveLength(2);
    expect(addFn!.exported).toBe(true);
    const helperFn = result.functions.find(f => f.name === 'helper');
    expect(helperFn!.exported).toBe(false);
  });

  it('extracts imports', async () => {
    const file = createGoFile('imports.go', `
package main

import "fmt"
import (
    "os"
    "path/filepath"
    f "bufio"
)
`);
    const result = await parser.parse(file);
    expect(result.imports.length).toBeGreaterThanOrEqual(4);
    const fmtImport = result.imports.find(i => i.from === 'fmt');
    expect(fmtImport).toBeDefined();
    const osImport = result.imports.find(i => i.from === 'os');
    expect(osImport).toBeDefined();
    const fpImport = result.imports.find(i => i.from === 'path/filepath');
    expect(fpImport).toBeDefined();
  });

  it('identifies exports from uppercase names', async () => {
    const file = createGoFile('exports.go', `
package main

type Config struct {
    Host string
}

func PublicFunc() {}
func privateFunc() {}
`);
    const result = await parser.parse(file);
    const exportNames = result.exports.map(e => e.name);
    expect(exportNames).toContain('Config');
    expect(exportNames).toContain('PublicFunc');
    expect(exportNames).not.toContain('privateFunc');
  });

  it('extracts interfaces', async () => {
    const file = createGoFile('iface.go', `
package main

type Reader interface {
    Read(p []byte) (n int, err error)
    Close() error
}
`);
    const result = await parser.parse(file);
    expect(result.types).toHaveLength(1);
    expect(result.types[0].name).toBe('Reader');
    expect(result.types[0].kind).toBe('interface');
    expect(result.types[0].properties.length).toBeGreaterThanOrEqual(2);
  });

  it('computes cyclomatic complexity', async () => {
    const file = createGoFile('complex.go', `
package main

func complexFunc(x int) int {
    if x > 0 {
        for i := 0; i < x; i++ {
            if i%2 == 0 {
                return i
            }
        }
    }
    return 0
}
`);
    const result = await parser.parse(file);
    const fn = result.functions.find(f => f.name === 'complexFunc');
    expect(fn!.complexity).toBeGreaterThanOrEqual(3); // if + for + if
  });

  it('extracts env vars', async () => {
    const file = createGoFile('env.go', `
package main

import "os"

func getConfig() string {
    return os.Getenv("DATABASE_URL")
}
`);
    const result = await parser.parse(file);
    expect(result.envVars).toContain('DATABASE_URL');
  });

  // === Receiver Method Tests ===

  it('associates receiver methods with struct', async () => {
    const file = createGoFile('methods.go', `
package main

type Server struct {
    Host string
    Port int
}

func (s *Server) Start() error {
    return nil
}

func (s *Server) Stop() {
    // stop
}
`);
    const result = await parser.parse(file);
    const server = result.classes.find(c => c.name === 'Server');
    expect(server).toBeDefined();
    expect(server!.methods).toHaveLength(2);
    expect(server!.methods.map(m => m.name)).toContain('Start');
    expect(server!.methods.map(m => m.name)).toContain('Stop');
  });

  it('resolves both pointer and value receivers', async () => {
    const file = createGoFile('receivers.go', `
package main

type Point struct {
    X int
    Y int
}

func (p *Point) Scale(factor int) {
    p.X *= factor
    p.Y *= factor
}

func (p Point) String() string {
    return "point"
}
`);
    const result = await parser.parse(file);
    const point = result.classes.find(c => c.name === 'Point');
    expect(point!.methods).toHaveLength(2);
  });

  it('handles method before struct definition', async () => {
    const file = createGoFile('order.go', `
package main

func (c *Config) Validate() bool {
    return true
}

type Config struct {
    Debug bool
}
`);
    const result = await parser.parse(file);
    const config = result.classes.find(c => c.name === 'Config');
    expect(config).toBeDefined();
    expect(config!.methods).toHaveLength(1);
    expect(config!.methods[0].name).toBe('Validate');
  });

  it('creates placeholder for unknown receiver struct', async () => {
    const file = createGoFile('external.go', `
package main

func (e *ExternalService) Call() string {
    return "called"
}
`);
    const result = await parser.parse(file);
    const ext = result.classes.find(c => c.name === 'ExternalService');
    expect(ext).toBeDefined();
    expect(ext!.methods).toHaveLength(1);
  });

  it('extracts calls from receiver methods', async () => {
    const file = createGoFile('calls.go', `
package main

type Logger struct{}

func (l *Logger) Info(msg string) {
    l.formatMessage(msg)
    processOutput(msg)
}

func (l *Logger) formatMessage(msg string) string {
    return "[INFO] " + msg
}
`);
    const result = await parser.parse(file);
    const logger = result.classes.find(c => c.name === 'Logger');
    const infoMethod = logger!.methods.find(m => m.name === 'Info');
    expect(infoMethod!.calls).toContain('formatMessage');
    expect(infoMethod!.calls).toContain('processOutput');
  });

  it('extracts instance variable accesses', async () => {
    const file = createGoFile('vars.go', `
package main

type App struct {
    DB    string
    Cache string
    name  string
}

func (a *App) Init() {
    a.DB = "connected"
    a.Cache = "ready"
    a.name = "myapp"
}
`);
    const result = await parser.parse(file);
    const app = result.classes.find(c => c.name === 'App');
    const initMethod = app!.methods.find(m => m.name === 'Init');
    expect(initMethod!.instanceVarAccesses).toContain('DB');
    expect(initMethod!.instanceVarAccesses).toContain('Cache');
    expect(initMethod!.instanceVarAccesses).toContain('name');
  });

  it('maps struct field visibility correctly', async () => {
    const file = createGoFile('visibility.go', `
package main

type Server struct {
    Host    string
    port    int
    MaxConn int
}
`);
    const result = await parser.parse(file);
    const server = result.classes[0];
    const host = server.properties.find(p => p.name === 'Host');
    const port = server.properties.find(p => p.name === 'port');
    const maxConn = server.properties.find(p => p.name === 'MaxConn');
    expect(host?.access).toBe('public');
    expect(port?.access).toBe('private');
    expect(maxConn?.access).toBe('public');
  });
});
