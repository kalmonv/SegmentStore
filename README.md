# SegmentStore

SegmentStore é uma biblioteca pequena de banco local em TypeScript puro, sem SQLite, Prisma ou binários nativos. Ela roda sobre APIs padrão de arquivos do Node.js, o que também a torna adequada para ambientes como NW.js.

## Instalação

```bash
npm install
```

Para usar como pacote publicado futuramente:

```bash
npm install segmentstore
```

## Exemplo

```ts
import { Database, field } from "segmentstore";

const db = await Database.open("./data/app.segmenteddb", {
  password: "senha-local"
});

const users = db.table("users", {
  id: field.int().primary().autoIncrement(),
  name: field.string().required(),
  email: field.string().unique().index(),
  age: field.int().default(0),
  avatar: field.blob().nullable(),
  active: field.boolean().default(true),
  metadata: field.json().nullable(),
  createdAt: field.datetime().default(() => new Date())
});

await users.insert({
  name: "Ana",
  email: "ana@example.com"
});

const adults = await users
  .where("age", ">=", 18)
  .where("active", "=", true)
  .orderBy("createdAt", "desc")
  .limit(10)
  .offset(0)
  .find();

await users.where("age", "=", 0).update(
  { email: "ana@example.com" },
  { age: 25 }
);

await users.delete({
  email: "ana@example.com"
});

await db.close();
```

O storage ativo do módulo é sempre o segmentado com carregamento lazy por tabela:

```ts
const db = await Database.open("./data/app.segmenteddb", {
  storageMode: "segmented",
  segmentSize: 1000,
  password: "senha-local"
});
```

`storageMode` pode ser omitido, porque `"segmented"` é o único modo usado por `Database.open()`. Quando `password` é informado, os arquivos JSON internos do banco são gravados criptografados.

## Arquitetura

Estrutura principal:

```txt
src/
  index.ts
  database.ts
  table.ts
  schema.ts
  field.ts
  query.ts
  errors.ts
  types.ts
  value.ts
  storage/
    storage-engine.ts
    segmented-storage-engine.ts
  index/
    index-manager.ts
tests/
  database.test.ts
  table.test.ts
  query.test.ts
  index.test.ts
  segmented-storage.test.ts
examples/
  basic.ts
  segmented.ts
  banco_dados.ts
```

Responsabilidades:

- `field.ts`: helpers fluentes (`field.int()`, `field.string()`, `primary()`, `default()`, etc.).
- `types.ts`: inferência de `RowOf`, `InsertInput`, `UpdateInput` e filtros.
- `schema.ts`: validação e resolução do schema.
- `table.ts`: insert, update, delete, find, validação, defaults e constraints.
- `query.ts`: query builder encadeável com `where`, `orderBy`, `limit`, `offset` e `update`.
- `storage/segmented-storage-engine.ts`: diretório por banco, segmentos por tabela, carregamento lazy de tabelas e criptografia opcional por senha.
- `index/index-manager.ts`: índices em memória reconstruídos a partir dos registros.

## Persistência

O módulo usa apenas o storage segmentado. O caminho do banco é um diretório com tabelas quebradas em segmentos:

```txt
data/app.segmenteddb/
  manifest.json
  tables/
    users/
      meta.json
      generations/
        3/
          segments/
            000000.json
            000001.json
            000002.json
```

Uso:

```ts
const db = await Database.open("./data/app.segmenteddb", {
  storageMode: "segmented",
  segmentSize: 1000,
  password: "senha-local"
});
```

Como funciona:

- `storageMode` aceita apenas `"segmented"` e pode ser omitido.
- `Database.open()` lê apenas metadados, sem hidratar todas as tabelas.
- `db.table("users", schema)` registra o schema, mas ainda não carrega os segmentos.
- A primeira operação async da tabela (`find`, `insert`, `update`, `delete`) chama `loadTable()` e carrega os segmentos daquela tabela.
- Cada save cria uma nova geração da tabela e troca `meta.json` como ponto de commit.
- Gerações antigas são removidas depois que a nova geração fica ativa.
- Escritas usam arquivo temporário, `fsync()` e `rename()`.
- Um lock simples em `.write.lock` serializa escritores.
- Datas são persistidas como ISO string e expostas como `Date`.
- Blobs são persistidos em base64 e expostos como `Uint8Array`.
- Índices não são persistidos. Eles são reconstruídos ao registrar/carregar a tabela.

### Criptografia

Quando `password` é informado, `manifest.json`, `meta.json` e os arquivos de segmentos são gravados como envelopes JSON criptografados com AES-256-GCM. A chave é derivada da senha com `scrypt` e cada arquivo usa salt e IV próprios.

Sem a senha correta, o banco não abre:

```ts
const db = await Database.open("./data/app.segmenteddb", {
  password: process.env.DB_PASSWORD ?? "senha-local"
});
```

Esse é um primeiro passo para bancos maiores: evita carregar todas as tabelas ao abrir. A versão atual ainda carrega a tabela inteira quando ela é usada, porque índices e validações de unique/primary ainda são reconstruídos em memória. Uma evolução mais profunda seria cache de páginas e índices persistidos por segmento.

## Recursos

- Criação e abertura de banco local.
- Tabelas com schema tipado.
- Tipos: `int`, `real`, `string`, `blob`, `datetime`, `boolean`, `json`.
- `insert`, `update`, `delete`, `find`.
- `where` com `=`, `!=`, `>`, `>=`, `<`, `<=`, `in`, `contains`.
- Múltiplas condições com AND.
- `orderBy`, `limit`, `offset`.
- Chave primária.
- `autoIncrement` para `int` primary key.
- Campos únicos.
- Índices simples em memória.
- Valores default estáticos ou por função.
- Campos `required` e `nullable`.
- Erros específicos: `ValidationError`, `UniqueConstraintError`, `PrimaryKeyError`, `StorageError`, etc.
- Build ESM e CommonJS.

## Comandos

Instalar dependências:

```bash
npm install
```

Checar tipos:

```bash
npm run typecheck
```

Rodar testes:

```bash
npm test
```

Rodar exemplos:

```bash
npm run example:basic
npm run example:segmented
npm run example:banco-dados
npm run example:import-database
```

Gerar build:

```bash
npm run build
```

Saídas do build:

```txt
dist/esm/
dist/cjs/
```

## Limitações atuais

- Não há parser SQL textual.
- Não há transações ACID completas.
- O lock reduz risco de escrita simultânea, mas não resolve concorrência avançada entre múltiplos processos com snapshots divergentes.
- Não há joins.
- Não há migrations automáticas.
- O engine `segmented` evita hidratar todas as tabelas na abertura, mas ainda carrega a tabela inteira ao usá-la.
- A criptografia protege o conteúdo dos arquivos, mas nomes de diretórios/tabelas continuam visíveis no sistema de arquivos.
- Consultas complexas ainda fazem scan em memória.
- Índices aceleram igualdade simples e `in` em campos indexados.
- Chaves estrangeiras ainda não foram implementadas nesta versão inicial.

## Próximas versões

- Transações.
- Migrations.
- Parser SQL opcional.
- Relações, chaves estrangeiras e joins.
- Compactação/vacuum com políticas configuráveis.
- Índices compostos.
- Cache de páginas/segmentos por consulta.
- Índices persistidos por segmento.
- Rotação/migração de senha para bancos criptografados.
