/**
 * Docker Service
 *
 * Container lifecycle management for BotMaker.
 * Wraps dockerode with domain-specific error handling and labeling.
 */

import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import type { ContainerStatus, ContainerInfo, ContainerConfig, ContainerStats } from '../types/container.js';
import { wrapDockerError } from './docker-errors.js';

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Label used to identify BotMaker-managed containers */
const LABEL_MANAGED = 'botmaker.managed';
const LABEL_BOT_ID = 'botmaker.bot-id';
const LABEL_BOT_HOSTNAME = 'botmaker.bot-hostname';

/**
 * Docker container lifecycle management service.
 * All containers are labeled for filtering and use bind-mounted secrets.
 */
export class DockerService {
  private docker: Docker;

  constructor() {
    // Uses /var/run/docker.sock by default
    this.docker = new Docker();
  }

  /**
   * Determine port bindings based on Caddy availability and public host setting.
   * 
   * Architecture:
   * - All bots listen on the same internal port (e.g., 8080) inside their container
   * - Each bot has a unique external port (19000+) for access
   * - When Caddy enabled: No port binding (Caddy proxies via container IP)
   * - When Caddy disabled: Map external port to internal port
   */
  private getPortBindings(config: ContainerConfig): Record<string, unknown[]> {
    if (config.caddyEnabled) {
      // Caddy runs in host network mode, proxies to container IP:internalPort
      // No host port binding needed
      return {};
    }

    // Dev mode: bind external port to internal port
    const bindIp = config.publicHost ? '0.0.0.0' : '127.0.0.1';
    return {
      [`${config.internalPort}/tcp`]: [{ HostIp: bindIp, HostPort: String(config.port) }]
    };
  }

  /**
   * Creates a new container for a bot.
   *
   * @param hostname - Hostname of the bot (used for container name)
   * @param botId - UUID of the bot (internal, passed as label)
   * @param config - Container configuration
   * @returns Container ID
   */
  async createContainer(hostname: string, botId: string, config: ContainerConfig): Promise<string> {
    const containerName = `botmaker-${hostname}`;

    try {
      const env = [
        ...config.environment,
        `OPENCLAW_STATE_DIR=/app/botdata`,
        `OPENCLAW_GATEWAY_TOKEN=${config.gatewayToken}`,
      ];

      const container = await this.docker.createContainer({
        name: containerName,
        Image: config.image,
        Cmd: ['node', 'openclaw.mjs', 'gateway'],
        Env: env,
        ExposedPorts: {
          [`${config.internalPort}/tcp`]: {}
        },
        Labels: {
          [LABEL_MANAGED]: 'true',
          [LABEL_BOT_ID]: botId,
          [LABEL_BOT_HOSTNAME]: hostname
        },
        Healthcheck: {
          Test: ['CMD', 'curl', '-sf', `http://localhost:${config.internalPort}/`],
          Interval: 2_000_000_000,  // 2s in nanoseconds
          Timeout: 3_000_000_000,   // 3s in nanoseconds
          Retries: 30,
          StartPeriod: 5_000_000_000,  // 5s in nanoseconds
        },
        HostConfig: {
          ShmSize: 1024 * 1024 * 1024,  // 1GB — Chromium needs larger /dev/shm
          Binds: [
            `${config.hostSecretsPath}:/run/secrets:ro`,
            `${config.hostWorkspacePath}:/app/botdata:rw`,
            `${config.hostSandboxPath}:/app/workspace:rw`
          ],
          PortBindings: this.getPortBindings(config),
          RestartPolicy: {
            Name: 'unless-stopped'
          },
          NetworkMode: config.networkName ?? 'bridge',
          ...(config.extraHosts && { ExtraHosts: config.extraHosts }),
        }
      });

      return container.id;
    } catch (err) {
      throw wrapDockerError(err, botId);
    }
  }

  /**
   * Starts a container for a bot.
   *
   * @param hostname - Hostname of the bot
   */
  async startContainer(hostname: string): Promise<void> {
    const containerName = `botmaker-${hostname}`;

    try {
      const container = this.docker.getContainer(containerName);
      await container.start();
    } catch (err) {
      const dockerErr = err as { statusCode?: number };

      // 304 = container already running, that's OK
      if (dockerErr.statusCode === 304) {
        return;
      }

      throw wrapDockerError(err, hostname);
    }
  }

  /**
   * Stops a container for a bot.
   *
   * @param hostname - Hostname of the bot
   * @param timeout - Seconds to wait before killing (default: 10)
   */
  async stopContainer(hostname: string, timeout = 10): Promise<void> {
    const containerName = `botmaker-${hostname}`;

    try {
      const container = this.docker.getContainer(containerName);
      await container.stop({ t: timeout });
    } catch (err) {
      const dockerErr = err as { statusCode?: number };

      // 304 = container already stopped, that's OK
      if (dockerErr.statusCode === 304) {
        return;
      }

      throw wrapDockerError(err, hostname);
    }
  }

  /**
   * Restarts a container for a bot.
   *
   * @param hostname - Hostname of the bot
   */
  async restartContainer(hostname: string): Promise<void> {
    const containerName = `botmaker-${hostname}`;

    try {
      const container = this.docker.getContainer(containerName);
      await container.restart();
    } catch (err) {
      throw wrapDockerError(err, hostname);
    }
  }

  /**
   * Removes a container for a bot.
   * Stops the container first if running.
   *
   * @param hostname - Hostname of the bot
   */
  async removeContainer(hostname: string): Promise<void> {
    const containerName = `botmaker-${hostname}`;

    try {
      const container = this.docker.getContainer(containerName);

      // Try to stop first (ignore if already stopped or doesn't exist)
      try {
        await container.stop({ t: 10 });
      } catch (stopErr) {
        const dockerErr = stopErr as { statusCode?: number };
        // 304 = already stopped, 404 = doesn't exist
        if (dockerErr.statusCode !== 304 && dockerErr.statusCode !== 404) {
          throw stopErr;
        }
      }

      await container.remove();
    } catch (err) {
      throw wrapDockerError(err, hostname);
    }
  }

  /**
   * Recreates a container with a new image, preserving key runtime configuration.
   * Inspects the existing container, removes it, and creates a new one that keeps
   * the same command, environment, exposed ports, labels, healthcheck, and relevant
   * host configuration (such as binds and networking), but uses the specified image.
   *
   * @param hostname - Hostname of the bot
   * @param newImage - Docker image to use for the new container
   * @returns New container ID
   */
  async recreateContainer(hostname: string, newImage: string): Promise<string> {
    const containerName = `botmaker-${hostname}`;

    try {
      const container = this.docker.getContainer(containerName);
      const info = await container.inspect();

      // Extract config from existing container (cast via unknown for dockerode types)
      const oldConfig = info.Config as unknown as {
        Cmd: string[]; Env: string[];
        ExposedPorts: Record<string, Record<string, never>>; Labels: Record<string, string>;
        Healthcheck: Docker.HealthConfig;
      };
      const oldHostConfig = info.HostConfig as unknown as {
        Binds: string[]; PortBindings: Record<string, { HostIp: string; HostPort: string }[]>;
        RestartPolicy: { Name: string }; NetworkMode: string;
        ExtraHosts: string[] | null; ShmSize: number;
      };

      // Stop and remove the old container
      try {
        await container.stop({ t: 10 });
      } catch (stopErr) {
        const dockerErr = stopErr as { statusCode?: number };
        if (dockerErr.statusCode !== 304 && dockerErr.statusCode !== 404) {
          throw stopErr;
        }
      }
      try {
        await container.remove();
      } catch (removeErr) {
        const dockerErr = removeErr as { statusCode?: number };
        if (dockerErr.statusCode !== 404) {
          throw removeErr;
        }
      }

      // Create new container with same config but new image
      const newContainer = await this.docker.createContainer({
        name: containerName,
        Image: newImage,
        Cmd: oldConfig.Cmd,
        Env: oldConfig.Env,
        ExposedPorts: oldConfig.ExposedPorts,
        Labels: oldConfig.Labels,
        Healthcheck: oldConfig.Healthcheck,
        HostConfig: {
          ShmSize: oldHostConfig.ShmSize || 1024 * 1024 * 1024,
          Binds: oldHostConfig.Binds,
          PortBindings: oldHostConfig.PortBindings,
          RestartPolicy: oldHostConfig.RestartPolicy,
          NetworkMode: oldHostConfig.NetworkMode,
          ...(oldHostConfig.ExtraHosts?.length ? { ExtraHosts: oldHostConfig.ExtraHosts } : {}),
        }
      });

      return newContainer.id;
    } catch (err) {
      throw wrapDockerError(err, hostname);
    }
  }

  /**
   * Gets the status of a container for a bot.
   *
   * @param hostname - Hostname of the bot
   * @returns Container status or null if not found
   */
  async getContainerStatus(hostname: string): Promise<ContainerStatus | null> {
    const containerName = `botmaker-${hostname}`;

    try {
      const container = this.docker.getContainer(containerName);
      const info = await container.inspect();

      // Extract health status from Docker's Health field
      const healthState = info.State.Health?.Status;
      let health: ContainerStatus['health'] = 'none';
      if (healthState === 'starting') health = 'starting';
      else if (healthState === 'healthy') health = 'healthy';
      else if (healthState === 'unhealthy') health = 'unhealthy';

      return {
        id: info.Id,
        state: info.State.Status as ContainerStatus['state'],
        running: info.State.Running,
        exitCode: info.State.ExitCode,
        startedAt: info.State.StartedAt,
        finishedAt: info.State.FinishedAt,
        health
      };
    } catch (err) {
      const dockerErr = err as { statusCode?: number };

      // 404 = container doesn't exist
      if (dockerErr.statusCode === 404) {
        return null;
      }

      throw wrapDockerError(err, hostname);
    }
  }

  /**
   * Lists all BotMaker-managed containers.
   *
   * @returns Array of container info
   */
  async listManagedContainers(): Promise<ContainerInfo[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: [`${LABEL_MANAGED}=true`]
      }
    });

    return containers.map(c => ({
      id: c.Id,
      name: c.Names[0]?.replace(/^\//, '') ?? '',
      botId: c.Labels[LABEL_BOT_ID] ?? '',
      hostname: c.Labels[LABEL_BOT_HOSTNAME] ?? '',
      state: c.State,
      status: c.Status
    }));
  }

  /**
   * Gets the host mountpoint for a Docker volume.
   *
   * @param volumeName - Name of the Docker volume
   * @returns Host path where the volume is mounted
   */
  async getVolumeMountpoint(volumeName: string): Promise<string> {
    const volume = this.docker.getVolume(volumeName);
    const info = await volume.inspect();
    return info.Mountpoint;
  }

  /**
   * Gets resource statistics for a container.
   *
   * @param hostname - Hostname of the bot
   * @returns Container stats or null if not found/not running
   */
  async getContainerStats(hostname: string): Promise<ContainerStats | null> {
    const containerName = `botmaker-${hostname}`;

    try {
      const container = this.docker.getContainer(containerName);
      const stats = await container.stats({ stream: false });

      // Calculate CPU percentage
      const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
      const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
      const cpuCount = stats.cpu_stats.online_cpus || 1;
      const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;

      // Memory stats
      const memoryUsage = stats.memory_stats.usage || 0;
      const memoryLimit = stats.memory_stats.limit || 0;
      const memoryPercent = memoryLimit > 0 ? (memoryUsage / memoryLimit) * 100 : 0;

      // Network stats (aggregate all interfaces)
      let networkRxBytes = 0;
      let networkTxBytes = 0;
      const networks = stats.networks as Record<string, { rx_bytes: number; tx_bytes: number }> | undefined;
      for (const iface of Object.values(networks ?? {})) {
        networkRxBytes += (iface as { rx_bytes: number }).rx_bytes || 0;
        networkTxBytes += (iface as { tx_bytes: number }).tx_bytes || 0;
      }

      return {
        hostname,
        name: containerName,
        cpuPercent: Math.round(cpuPercent * 100) / 100,
        memoryUsage,
        memoryLimit,
        memoryPercent: Math.round(memoryPercent * 100) / 100,
        networkRxBytes,
        networkTxBytes,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      const dockerErr = err as { statusCode?: number };

      // 404 = container doesn't exist, 409 = container not running
      if (dockerErr.statusCode === 404 || dockerErr.statusCode === 409) {
        return null;
      }

      throw wrapDockerError(err, hostname);
    }
  }

  /**
   * Gets resource statistics for all running BotMaker containers.
   *
   * @returns Array of container stats
   */
  async getAllContainerStats(): Promise<ContainerStats[]> {
    const containers = await this.listManagedContainers();
    const runningContainers = containers.filter(c => c.state === 'running');

    const stats = await Promise.all(
      runningContainers.map(async (container) => {
        try {
          return await this.getContainerStats(container.hostname);
        } catch {
          return null;
        }
      })
    );

    return stats.filter((s): s is ContainerStats => s !== null);
  }

  /**
   * Executes a command inside a running container.
   *
   * @param hostname - Hostname of the bot
   * @param cmd - Command and arguments to execute
   * @param timeoutMs - Timeout in milliseconds (default: 30000)
   * @returns Exit code, stdout, and stderr
   */
  async execCommand(hostname: string, cmd: string[], timeoutMs = 30_000): Promise<ExecResult> {
    const containerName = `botmaker-${hostname}`;

    try {
      const container = this.docker.getContainer(containerName);
      const exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true,
      });

      const stream = await exec.start({ hijack: true, stdin: false });

      return await new Promise<ExecResult>((resolve, reject) => {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        const timeout = setTimeout(() => {
          stream.destroy();
          reject(new Error(`Exec timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        const stdoutStream = new PassThrough();
        const stderrStream = new PassThrough();

        stdoutStream.on('data', (chunk: Buffer) => { stdoutChunks.push(chunk); });
        stderrStream.on('data', (chunk: Buffer) => { stderrChunks.push(chunk); });

        this.docker.modem.demuxStream(stream, stdoutStream, stderrStream);

        stream.on('end', () => {
          clearTimeout(timeout);
          exec.inspect()
            .then((inspectResult) => {
              resolve({
                exitCode: inspectResult.ExitCode ?? -1,
                stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
                stderr: Buffer.concat(stderrChunks).toString('utf-8'),
              });
            })
            .catch((err: unknown) => {
              reject(err instanceof Error ? err : new Error(String(err)));
            });
        });

        stream.on('error', (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    } catch (err) {
      // Don't wrap exec timeouts — wrapDockerError would misclassify
      // "Exec timed out" as NETWORK_ERROR ("Docker daemon connection timeout")
      if (err instanceof Error && err.message.startsWith('Exec timed out')) {
        throw err;
      }
      throw wrapDockerError(err, hostname);
    }
  }
}

export default DockerService;
