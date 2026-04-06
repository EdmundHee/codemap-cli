import { RustParser } from '../rust-parser';
import { ScannedFile } from '../../../core/scanner';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('RustParser', () => {
  let parser: RustParser;
  let tempDir: string;

  beforeAll(() => {
    parser = new RustParser();
    tempDir = join(tmpdir(), 'rust-parser-test-' + Date.now());
    mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createRustFile(name: string, content: string): ScannedFile {
    const filePath = join(tempDir, name);
    writeFileSync(filePath, content);
    return { absolute: filePath, relative: name, language: 'rust' as any };
  }

  // Test 1: parse struct with fields and visibility
  it('parses a struct with fields and visibility', async () => {
    const file = createRustFile('model.rs', `
pub struct User {
    pub name: String,
    email: String,
    pub age: u32,
}
`);
    const result = await parser.parse(file);
    expect(result.classes).toHaveLength(1);
    expect(result.classes[0].name).toBe('User');
    expect(result.classes[0].properties).toHaveLength(3);
    const name = result.classes[0].properties.find(p => p.name === 'name');
    expect(name?.access).toBe('public');
    const email = result.classes[0].properties.find(p => p.name === 'email');
    expect(email?.access).toBe('private');
  });

  // Test 2: parse free functions
  it('parses free functions with params and visibility', async () => {
    const file = createRustFile('funcs.rs', `
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

fn helper() -> String {
    String::from("help")
}
`);
    const result = await parser.parse(file);
    expect(result.functions.length).toBeGreaterThanOrEqual(2);
    const addFn = result.functions.find(f => f.name === 'add');
    expect(addFn).toBeDefined();
    expect(addFn!.exported).toBe(true);
    expect(addFn!.params).toHaveLength(2);
    const helperFn = result.functions.find(f => f.name === 'helper');
    expect(helperFn!.exported).toBe(false);
  });

  // Test 3: extract use imports
  it('extracts use imports', async () => {
    const file = createRustFile('imports.rs', `
use std::collections::HashMap;
use std::io::{Read, Write};
use serde::Serialize;
`);
    const result = await parser.parse(file);
    expect(result.imports.length).toBeGreaterThanOrEqual(3);
    const hashmap = result.imports.find(i => i.symbols.includes('HashMap'));
    expect(hashmap).toBeDefined();
  });

  // Test 4: glob imports
  it('extracts glob imports with isNamespace', async () => {
    const file = createRustFile('glob.rs', `
use std::io::prelude::*;
`);
    const result = await parser.parse(file);
    expect(result.imports.length).toBeGreaterThanOrEqual(1);
    const glob = result.imports.find(i => i.isNamespace === true);
    expect(glob).toBeDefined();
  });

  // Test 5: parse enums as TypeInfo
  it('parses enums as TypeInfo', async () => {
    const file = createRustFile('enums.rs', `
pub enum Color {
    Red,
    Green,
    Blue,
    Custom(u8, u8, u8),
}
`);
    const result = await parser.parse(file);
    const colorType = result.types.find(t => t.name === 'Color');
    expect(colorType).toBeDefined();
    expect(colorType!.kind).toBe('enum');
    expect(colorType!.properties.length).toBeGreaterThanOrEqual(4);
  });

  // Test 6: parse traits as TypeInfo (kind: 'interface')
  it('parses traits as TypeInfo with interface kind', async () => {
    const file = createRustFile('traits.rs', `
pub trait Drawable {
    fn draw(&self);
    fn area(&self) -> f64;
}
`);
    const result = await parser.parse(file);
    const drawable = result.types.find(t => t.name === 'Drawable');
    expect(drawable).toBeDefined();
    expect(drawable!.kind).toBe('interface');
    expect(drawable!.properties.length).toBeGreaterThanOrEqual(2);
  });

  // Test 7: cyclomatic complexity
  it('computes cyclomatic complexity', async () => {
    const file = createRustFile('complex.rs', `
fn complex(x: i32) -> i32 {
    if x > 0 {
        match x {
            1 => 1,
            2 => 2,
            _ => {
                for i in 0..x {
                    if i % 2 == 0 {
                        return i;
                    }
                }
                0
            }
        }
    } else {
        0
    }
}
`);
    const result = await parser.parse(file);
    const fn_ = result.functions.find(f => f.name === 'complex');
    expect(fn_!.complexity).toBeGreaterThanOrEqual(4);
  });

  // Test 8: env var extraction
  it('extracts std::env::var as env vars', async () => {
    const file = createRustFile('env.rs', `
use std::env;

fn get_config() -> String {
    env::var("DATABASE_URL").unwrap()
}
`);
    const result = await parser.parse(file);
    expect(result.envVars).toContain('DATABASE_URL');
  });

  // Test 9: impl block methods added to struct
  it('associates impl block methods with struct', async () => {
    const file = createRustFile('impl_basic.rs', `
struct MyStruct {
    value: i32,
}

impl MyStruct {
    pub fn new(v: i32) -> Self {
        MyStruct { value: v }
    }

    pub fn get_value(&self) -> i32 {
        self.value
    }

    fn private_method(&mut self) {
        self.value = 0;
    }
}
`);
    const result = await parser.parse(file);
    const my = result.classes.find(c => c.name === 'MyStruct');
    expect(my).toBeDefined();
    expect(my!.methods).toHaveLength(3);
    expect(my!.methods.map(m => m.name)).toContain('new');
    expect(my!.methods.map(m => m.name)).toContain('get_value');
    expect(my!.methods.map(m => m.name)).toContain('private_method');
    // Check access
    const newMethod = my!.methods.find(m => m.name === 'new');
    expect(newMethod!.access).toBe('public');
    const privMethod = my!.methods.find(m => m.name === 'private_method');
    expect(privMethod!.access).toBe('private');
  });

  // Test 10: trait impl adds trait to implements and methods to ClassInfo
  it('handles trait impl with implements', async () => {
    const file = createRustFile('impl_trait.rs', `
struct MyStruct {
    name: String,
}

impl Display for MyStruct {
    fn fmt(&self, f: &mut Formatter) -> fmt::Result {
        write!(f, "{}", self.name)
    }
}
`);
    const result = await parser.parse(file);
    const my = result.classes.find(c => c.name === 'MyStruct');
    expect(my).toBeDefined();
    expect(my!.implements).toContain('Display');
    expect(my!.methods.length).toBeGreaterThanOrEqual(1);
    expect(my!.methods.map(m => m.name)).toContain('fmt');
  });

  // Test 11: multiple impl blocks merged
  it('merges multiple impl blocks for same struct', async () => {
    const file = createRustFile('impl_multi.rs', `
struct Counter {
    count: u32,
}

impl Counter {
    pub fn new() -> Self {
        Counter { count: 0 }
    }
}

impl Counter {
    pub fn increment(&mut self) {
        self.count += 1;
    }

    pub fn get(&self) -> u32 {
        self.count
    }
}
`);
    const result = await parser.parse(file);
    const counter = result.classes.find(c => c.name === 'Counter');
    expect(counter).toBeDefined();
    expect(counter!.methods).toHaveLength(3);
  });

  // Test 12: impl for struct defined later in file
  it('resolves impl for struct defined later', async () => {
    const file = createRustFile('impl_order.rs', `
impl Config {
    pub fn validate(&self) -> bool {
        true
    }
}

struct Config {
    debug: bool,
}
`);
    const result = await parser.parse(file);
    const config = result.classes.find(c => c.name === 'Config');
    expect(config).toBeDefined();
    expect(config!.methods).toHaveLength(1);
  });

  // Test 13: self.field accesses extracted
  it('extracts self.field instance variable accesses', async () => {
    const file = createRustFile('impl_vars.rs', `
struct App {
    db: String,
    cache: String,
}

impl App {
    pub fn init(&mut self) {
        self.db = String::from("connected");
        self.cache = String::from("ready");
    }
}
`);
    const result = await parser.parse(file);
    const app = result.classes.find(c => c.name === 'App');
    const initMethod = app!.methods.find(m => m.name === 'init');
    expect(initMethod!.instanceVarAccesses).toContain('db');
    expect(initMethod!.instanceVarAccesses).toContain('cache');
  });

  // Test 14: method calls normalized for call graph
  it('normalizes method call expressions', async () => {
    const file = createRustFile('impl_calls.rs', `
struct Logger {}

impl Logger {
    pub fn info(&self, msg: &str) {
        self.emit_log(msg);
    }

    fn emit_log(&self, msg: &str) -> String {
        String::from(msg)
    }
}
`);
    const result = await parser.parse(file);
    const logger = result.classes.find(c => c.name === 'Logger');
    const infoMethod = logger!.methods.find(m => m.name === 'info');
    // self.emit_log should be normalized to just "emit_log"
    expect(infoMethod!.calls).toContain('emit_log');
  });

  // Test 15: macro definitions
  it('captures macro definitions as functions', async () => {
    const file = createRustFile('macros.rs', `
macro_rules! say_hello {
    () => {
        println!("Hello!");
    };
}
`);
    const result = await parser.parse(file);
    const macro_ = result.functions.find(f => f.name === 'macro:say_hello');
    expect(macro_).toBeDefined();
  });
});
