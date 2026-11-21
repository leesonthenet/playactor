import * as chai from "chai";
import net from "net";
import sinon from "sinon";

import { RemotePlayDeviceConnection } from "../../src/connection/remoteplay";
import { IRemotePlayCredentials } from "../../src/credentials/model";
import { ConnectionIntent } from "../../src/device/model";
import {
    DeviceStatus,
    DeviceType,
    DiscoveryVersions,
    IDiscoveredDevice,
} from "../../src/discovery/model";
import { RemotePlayPacketCodec } from "../../src/remoteplay/codec";
import { pickCryptoStrategyForDevice } from "../../src/remoteplay/crypto";
import { RemotePlayCommand } from "../../src/remoteplay/packets";
import * as protocol from "../../src/remoteplay/protocol";
import { openSession } from "../../src/remoteplay/session";

chai.should();

const REGIST_KEY = "00112233445566778899aabbccddeeff";

/**
 * Simulates the PS5 control endpoint using a real local TCP connection.
 * This exercises the HTTP-agent handover introduced by PR #72.
 */
async function startConsole(serverType: string) {
    const sockets = new Set<net.Socket>();
    const commands: number[] = [];

    let notifyStandby: (() => void) | undefined;
    const standbyReceived = new Promise<void>(resolve => {
        notifyStandby = resolve;
    });

    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.on("close", () => sockets.delete(socket));

        let buffer = Buffer.alloc(0);
        let requestComplete = false;

        socket.on("data", data => {
            buffer = Buffer.concat([buffer, data]);

            if (!requestComplete) {
                const end = buffer.indexOf("\r\n\r\n");
                if (end === -1) {
                    return;
                }

                requestComplete = true;
                buffer = buffer.subarray(end + 4);

                socket.write(
                    "HTTP/1.1 200 OK\r\n"
                    + "Content-Length: 0\r\n"
                    + "Connection: keep-alive\r\n"
                    + `RP-Server-Type: ${serverType}\r\n\r\n`,
                );
            }

            while (buffer.length >= 8) {
                const payloadLength = buffer.readUInt32BE(0);
                if (buffer.length < 8 + payloadLength) {
                    break;
                }

                const command = buffer.readUInt16BE(4);
                commands.push(command);
                buffer = buffer.subarray(8 + payloadLength);

                if (command === RemotePlayCommand.Standby) {
                    notifyStandby?.();
                    // The console closes the connection when entering Rest Mode.
                    socket.destroy();
                    return;
                }
            }
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", reject);
            resolve();
        });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Invalid test server address");
    }

    return {
        port: address.port,
        commands,
        standbyReceived,
        close: async () => {
            sockets.forEach(socket => socket.destroy());
            await new Promise<void>(resolve => server.close(() => resolve()));
        },
    };
}

describe("Remote Play session", function remotePlaySession() {
    this.timeout(5000);
    afterEach(() => {
        sinon.restore();
    });

    it("sends Standby without logging in", async () => {
        const device: IDiscoveredDevice = {
            address: { address: "127.0.0.1", port: 9295, family: "IPv4" },
            hostRequestPort: 997,
            extras: {},
            discoveryVersion: DiscoveryVersions.PS5,
            systemVersion: "14100003",
            id: "0123456789AB",
            name: "PS5",
            status: DeviceStatus.AWAKE,
            type: DeviceType.PS5,
        };
        const creds: IRemotePlayCredentials = {
            "app-type": "r",
            "auth-type": "R",
            "client-type": "vr",
            "user-credential": "1234567890",
            accountId: "1234567890",
            registration: {
                "AP-Bssid": "0123456789ab",
                "AP-Name": "PS5",
                "PS5-RegistKey": REGIST_KEY,
                "RP-KeyType": "2",
                "RP-Key": REGIST_KEY,
            },
        };

        const nonce = Buffer.alloc(16, 0x42);
        const serverCodec = new RemotePlayPacketCodec(
            pickCryptoStrategyForDevice(device),
            creds,
            nonce,
        );
        const serverType = serverCodec.encodeBuffer(Buffer.alloc(16, 0));
        const server = await startConsole(serverType.toString("base64"));

        try {
            sinon.stub(protocol, "request").resolves({
                headers: { "rp-nonce": nonce.toString("base64") },
            } as any);

            sinon.stub(protocol, "urlWith").callsFake((_device, path) => (
                `http://127.0.0.1:${server.port}${path}`
            ));

            const session = await openSession(device, {
                intent: ConnectionIntent.STANDBY,
            }, creds);

            await new RemotePlayDeviceConnection(session).standby();
            await Promise.race([
                server.standbyReceived,
                new Promise<never>((_resolve, reject) => {
                    setTimeout(() => reject(
                        new Error("Simulated console did not receive Standby"),
                    ), 1500).unref();
                }),
            ]);

            // Standby must be the only outgoing Remote Play command.
            chai.expect(server.commands).to.deep.equal([
                RemotePlayCommand.Standby,
            ]);
        } finally {
            await server.close();
        }
    });
});
