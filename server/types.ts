import type { Env } from "./env";
import type { User } from "../shared/types";

export type AppEnv = { Bindings: Env; Variables: { user: User } };
