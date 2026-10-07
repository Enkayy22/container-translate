export type DependsCondition =
  | 'service_started'
  | 'service_healthy'
  | 'service_completed_successfully';

export type Mount = {
  kind: 'bind' | 'volume' | 'anonymous';
  source?: string;
  target: string;
  options?: string;
};

export type Healthcheck = {
  test: string[];
  intervalMs: number;
  timeoutMs: number;
  retries: number;
  startPeriodMs: number;
};

export type EnvVar = {
  key: string;
  value?: string;
};

export type BuildSpec = {
  context: string;
  dockerfile?: string;
  args: Record<string, string>;
};

export type Service = {
  name: string;
  image?: string;
  build?: BuildSpec;
  containerName: string;
  ports: string[];
  environment: EnvVar[];
  command?: string[];
  entrypoint?: string[];
  mounts: Mount[];
  tmpfs: string[];
  dependsOn: Array<{ service: string; condition: DependsCondition }>;
  healthcheck?: Healthcheck;
  restart?: string;
  networkName?: string;
  user?: string;
  workdir?: string;
  dns: string[];
  platform?: string;
  capAdd: string[];
  capDrop: string[];
  readOnly: boolean;
  shmSize?: string;
  init: boolean;
  tty: boolean;
  interactive: boolean;
  memory?: string;
  cpus?: string;
  ulimits: string[];
  stopSignal?: string;
  stopGraceSeconds?: number;
};

export type NetworkSpec = {
  key: string;
  name: string;
  external: boolean;
  subnet?: string;
};

export type VolumeSpec = {
  key: string;
  name: string;
  external: boolean;
};

export type Project = {
  name: string;
  composeDir: string;
  filePaths: string[];
  services: Service[];
  networks: NetworkSpec[];
  volumes: VolumeSpec[];
  warnings: string[];
};

export const PROJECT_LABEL = 'dev.container-translate.project';
export const SERVICE_LABEL = 'dev.container-translate.service';
