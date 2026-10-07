# container-translate

Run Docker CLI commands and Compose files on Apple Container. This is a translation layer for Apple Silicon Macs that no longer have Docker Desktop.

Apple Container (`container`) starts Linux micro-VMs with macOS Virtualization.framework. It is enough to run Kafka, PostgreSQL, Redis, and similar compose stacks once the file is translated into `container network`, `container volume`, and `container run`.

## Why a socket symlink does not work

`docker compose` speaks the Docker Engine HTTP API on `unix:///var/run/docker.sock`. Apple Container exposes `container-apiserver`, which is a different protocol. Pointing the Docker socket at Apple's socket does not make Compose work.

`sudo docker` fails for a second, independent reason. `sudo` does not expand shell functions or aliases. On macOS its search path is `secure_path`, usually `/usr/bin:/bin:/usr/sbin:/sbin`. A wrapper in `~/.local/bin` or `/usr/local/bin` is invisible to `sudo`, so the command falls through to a missing Docker Desktop binary. Apple Container runs as your user. Do not put `sudo` in front of it.

## Install

Requires Node.js 20 or newer and the `container` CLI (`container system start` once, so the kernel is installed).

```bash
git clone <this repo> ~/container-translate
cd ~/container-translate
./scripts/install.sh
```

The installer builds the CLI and links three commands into `~/.local/bin`:

| Command | Role |
| --- | --- |
| `container-translate` | Doctor, plan, and compose |
| `docker-compose` | Reads a compose file and runs `container` |
| `docker` | Translates common Docker CLI verbs onto `container` |

Open a new terminal afterwards. `~/.local/bin` has to come before both `/opt/homebrew/bin` and `/usr/local/bin`. Homebrew's `docker` and `docker-compose` are real Engine clients: they still look for `docker.sock`. A zsh function named `docker()` also wins over any binary. The installer prepends `~/.local/bin` and runs `unfunction docker` so the shim is the command that actually runs.

```bash
which docker docker-compose container-translate
container-translate doctor
```

## Compose

Several compose files in one directory stay separate. The project name defaults to the file slug (`docker-compose.kafka.yml` becomes project `kafka`), not the directory name. Override it with `-p`.

```bash
container-translate plan -f docker-compose.kafka.yml
docker-compose -f docker-compose.kafka.yml up -d
docker-compose -f docker-compose.kafka.yml logs -f kafka
docker-compose -f docker-compose.kafka.yml down

docker-compose -f docker-compose.postgresql.yaml up -d
docker-compose -f docker-compose.postgresql.yaml down -v
```

`up` always detaches. Each container is its own VM, and `logs -f <service>` follows one of them.

A Makefile that already calls `docker-compose -f ... up -d` keeps working once the shim is first on `PATH`.

What is translated:

- images, build, command, entrypoint, environment, env files, `${VAR}` interpolation
- published ports, including `/udp`
- named volumes, bind mounts, tmpfs
- one network per stack, so service names resolve (`zookeeper:2181`, `kafka:29092`)
- `depends_on` order, and healthcheck polling when a dependency asks for `service_healthy`
- `down`, including `-v` to delete named volumes created for that file

`restart`, `privileged`, `devices`, `deploy`, and extra hosts are reported as warnings. `include` and `extends` are rejected. This layer does not implement the Docker Engine API, so tools that open `docker.sock` themselves still need a real engine.

## Single containers

```bash
docker ps -a
docker images
docker pull postgres:15-alpine
docker run -d --name db -p 5432:5432 -e POSTGRES_PASSWORD=app-secret postgres:15-alpine
docker logs -f --tail 50 db
docker exec -it db sh
docker rm -f db
```

`docker compose ...` is handled by the same translator as `docker-compose`. Flags that only exist on Docker Engine (`--restart`, healthcheck flags, `--privileged`) are dropped with a warning instead of being forwarded to `container`.

## Development

```bash
nvm use 20
npm install
npm test
```
