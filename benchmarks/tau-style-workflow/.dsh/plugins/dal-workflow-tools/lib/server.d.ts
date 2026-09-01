import { createServer } from "node:http";
import { type ServiceEnvironment } from "./service.js";
export declare function createWorkflowServiceServer(env: ServiceEnvironment, options: {
    evaluatorToken: string;
}): ReturnType<typeof createServer>;
