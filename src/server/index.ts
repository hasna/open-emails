#!/usr/bin/env bun
import { startServer } from "./serve.js";

const port = process.env["PORT"] ? parseInt(process.env["PORT"], 10) : 3900;
await startServer(port);
