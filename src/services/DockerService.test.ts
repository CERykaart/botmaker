import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Mock dockerode before importing DockerService
const mockExec = vi.fn();
const mockExecStart = vi.fn();
const mockExecInspect = vi.fn();
const mockGetContainer = vi.fn();
const mockCreateContainer = vi.fn();
const mockListContainers = vi.fn();
const mockDemuxStream = vi.fn();

vi.mock('dockerode', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      getContainer: mockGetContainer,
      createContainer: mockCreateContainer,
      listContainers: mockListContainers,
      modem: {
        demuxStream: mockDemuxStream,
      },
    })),
  };
});

import { DockerService } from './DockerService.js';
import { ContainerError } from './docker-errors.js';

describe('DockerService.execCommand', () => {
  let docker: DockerService;

  beforeEach(() => {
    vi.clearAllMocks();
    docker = new DockerService();

    // Default mock chain: getContainer -> exec -> start
    mockGetContainer.mockReturnValue({
      exec: mockExec,
    });
    mockExec.mockResolvedValue({
      start: mockExecStart,
      inspect: mockExecInspect,
    });
  });

  it('should execute command and return stdout', async () => {
    const stream = new EventEmitter();

    mockExecStart.mockResolvedValue(stream);
    mockExecInspect.mockResolvedValue({ ExitCode: 0 });

    // When demuxStream is called, write to stdout and end the stream
    mockDemuxStream.mockImplementation((_stream: EventEmitter, stdout: PassThrough) => {
      stdout.write(Buffer.from('hello world\n'));
      process.nextTick(() => { stream.emit('end'); });
    });

    const result = await docker.execCommand('bob', ['echo', 'hello']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world\n');
    expect(result.stderr).toBe('');

    expect(mockGetContainer).toHaveBeenCalledWith('botmaker-bob');
    expect(mockExec).toHaveBeenCalledWith({
      Cmd: ['echo', 'hello'],
      AttachStdout: true,
      AttachStderr: true,
    });
  });

  it('should capture stderr separately', async () => {
    const stream = new EventEmitter();

    mockExecStart.mockResolvedValue(stream);
    mockExecInspect.mockResolvedValue({ ExitCode: 1 });

    mockDemuxStream.mockImplementation((_stream: EventEmitter, _stdout: PassThrough, stderr: PassThrough) => {
      stderr.write(Buffer.from('error occurred\n'));
      process.nextTick(() => { stream.emit('end'); });
    });

    const result = await docker.execCommand('bob', ['bad-command']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('error occurred\n');
  });

  it('should timeout and reject', async () => {
    const stream = new EventEmitter() as EventEmitter & { destroy: () => void };
    stream.destroy = vi.fn();

    mockExecStart.mockResolvedValue(stream);

    mockDemuxStream.mockImplementation(() => {
      // Never emit 'end' — simulates a hanging command
    });

    await expect(docker.execCommand('bob', ['sleep', '999'], 50)).rejects.toThrow(
      'Exec timed out after 50ms',
    );

    expect(stream.destroy).toHaveBeenCalled();
  });

  it('should throw plain Error for exec timeout, not ContainerError', async () => {
    const stream = new EventEmitter() as EventEmitter & { destroy: () => void };
    stream.destroy = vi.fn();

    mockExecStart.mockResolvedValue(stream);

    mockDemuxStream.mockImplementation(() => {
      // Never emit 'end' — simulates a hanging command
    });

    try {
      await docker.execCommand('bob', ['sleep', '999'], 50);
      expect.fail('should have thrown');
    } catch (err) {
      // Must be a plain Error, NOT a ContainerError with NETWORK_ERROR code
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ContainerError);
      expect((err as Error).message).toContain('Exec timed out');
    }
  });

  it('should handle stream errors', async () => {
    const stream = new EventEmitter();

    mockExecStart.mockResolvedValue(stream);

    mockDemuxStream.mockImplementation(() => {
      process.nextTick(() => { stream.emit('error', new Error('stream broke')); });
    });

    await expect(docker.execCommand('bob', ['cmd'])).rejects.toThrow('stream broke');
  });

  it('should return -1 exit code when ExitCode is null', async () => {
    const stream = new EventEmitter();

    mockExecStart.mockResolvedValue(stream);
    mockExecInspect.mockResolvedValue({ ExitCode: null });

    mockDemuxStream.mockImplementation((_stream: EventEmitter, stdout: PassThrough) => {
      stdout.write(Buffer.from('output'));
      process.nextTick(() => { stream.emit('end'); });
    });

    const result = await docker.execCommand('bob', ['cmd']);
    expect(result.exitCode).toBe(-1);
  });
});

describe('DockerService.recreateContainer', () => {
  let docker: DockerService;
  const mockStop = vi.fn();
  const mockRemove = vi.fn();
  const mockInspect = vi.fn();

  const fakeInspectResult = {
    Config: {
      Cmd: ['node', 'openclaw.mjs', 'gateway'],
      Env: ['BOT_ID=123', 'PORT=19000', 'OPENCLAW_STATE_DIR=/app/botdata'],
      ExposedPorts: { '8080/tcp': {} },
      Labels: {
        'botmaker.managed': 'true',
        'botmaker.bot-id': 'uuid-123',
        'botmaker.bot-hostname': 'bob',
      },
      Healthcheck: {
        Test: ['CMD', 'curl', '-sf', 'http://localhost:8080/'],
        Interval: 2_000_000_000,
        Timeout: 3_000_000_000,
        Retries: 30,
        StartPeriod: 5_000_000_000,
      },
    },
    HostConfig: {
      Binds: [
        '/data/secrets/bob:/run/secrets:ro',
        '/data/bots/bob:/app/botdata:rw',
        '/data/bots/bob/sandbox:/app/workspace:rw',
      ],
      PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '19000' }] },
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: 'bm-internal',
      ExtraHosts: null,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    docker = new DockerService();

    mockGetContainer.mockReturnValue({
      inspect: mockInspect,
      stop: mockStop,
      remove: mockRemove,
    });
    mockInspect.mockResolvedValue(fakeInspectResult);
    mockStop.mockResolvedValue(undefined);
    mockRemove.mockResolvedValue(undefined);
    mockCreateContainer.mockResolvedValue({ id: 'new-container-id-456' });
  });

  it('should inspect old container, remove it, and create new one with new image', async () => {
    const newId = await docker.recreateContainer('bob', 'botmaker-env:v2');

    expect(newId).toBe('new-container-id-456');

    // Should have inspected and stopped the old container
    expect(mockGetContainer).toHaveBeenCalledWith('botmaker-bob');
    expect(mockStop).toHaveBeenCalledWith({ t: 10 });
    expect(mockRemove).toHaveBeenCalled();

    // Should create new container with new image but same config
    expect(mockCreateContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'botmaker-bob',
        Image: 'botmaker-env:v2',
        Cmd: fakeInspectResult.Config.Cmd,
        Env: fakeInspectResult.Config.Env,
        ExposedPorts: fakeInspectResult.Config.ExposedPorts,
        Labels: fakeInspectResult.Config.Labels,
        Healthcheck: fakeInspectResult.Config.Healthcheck,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        HostConfig: expect.objectContaining({
          Binds: fakeInspectResult.HostConfig.Binds,
          PortBindings: fakeInspectResult.HostConfig.PortBindings,
          RestartPolicy: fakeInspectResult.HostConfig.RestartPolicy,
          NetworkMode: 'bm-internal',
        }),
      }),
    );
  });

  it('should handle container already stopped (304)', async () => {
    mockStop.mockRejectedValue({ statusCode: 304 });

    const newId = await docker.recreateContainer('bob', 'botmaker-env:v2');

    expect(newId).toBe('new-container-id-456');
    expect(mockRemove).toHaveBeenCalled();
    expect(mockCreateContainer).toHaveBeenCalled();
  });

  it('should preserve ExtraHosts when present', async () => {
    mockInspect.mockResolvedValue({
      ...fakeInspectResult,
      HostConfig: {
        ...fakeInspectResult.HostConfig,
        ExtraHosts: ['host.docker.internal:host-gateway'],
      },
    });

    await docker.recreateContainer('bob', 'botmaker-env:v2');

    expect(mockCreateContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        HostConfig: expect.objectContaining({
          ExtraHosts: ['host.docker.internal:host-gateway'],
        }),
      }),
    );
  });

  it('should throw ContainerError when container not found', async () => {
    mockGetContainer.mockReturnValue({
      inspect: vi.fn().mockRejectedValue({ statusCode: 404, message: 'no such container' }),
    });

    await expect(docker.recreateContainer('nonexistent', 'img')).rejects.toThrow(ContainerError);
  });
});
