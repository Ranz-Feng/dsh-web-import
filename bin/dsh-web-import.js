#!/usr/bin/env node
import { runCli } from "../src/cli.js";

runCli().catch((error) => {
  console.error(`\n导入失败：${error?.stack ?? error}`);
  process.exit(1);
});
