#region Copyright & License Information
/*
 * Copyright (c) The OpenRA Developers and Contributors
 * This file is part of OpenRA, which is free software. It is made
 * available to you under the terms of the GNU General Public License
 * as published by the Free Software Foundation, either version 3 of
 * the License, or (at your option) any later version. For more
 * information, see COPYING.
 */
#endregion

// Browser WebSocket transport for network sessions.
//
// The shared engine's WebSocketConnection is built on System.Net.WebSockets.ClientWebSocket,
// which throws PlatformNotSupportedException on browser-wasm (no raw socket transport in the
// browser runtime). This host-side replacement drives the browser's native WebSocket API and
// feeds the bytes through the SAME WsFrameAssembler contract, so the wire behavior (8-byte
// length-prefixed frames and the version handshake) is identical. The page's JavaScript owns
// the native WebSocket and calls Program.MpWs* exports directly from the WebSocket event
// handlers. Both directions use only the [JSExport] surface, which is the one interop path
// this runtime provably supports.
//
// Byte flow (single wasm heap; JS and C# share linear memory):
//   C# -> JS: SendBytes enqueues the frame bytes; the pump serves them by copying a chunk
//             into the pinned sendBuffer, and JS reads it out via the send pointer.
//   JS -> C#: onmessage writes the payload into the pinned recvBuffer at recvPtr and calls
//             MpWsOnMessage(id, length); the callback enqueues the chunk exactly like the
//             reference ReceiveLoopAsync did, and PumpTransport drives the assembler.
// Buffers are pinned (GCHandleType.Pinned) for the connection's lifetime so the addresses we
// hand to JS stay valid.

using System;
using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Threading;
using OpenRA.Network;

namespace OpenRA
{
	[SupportedOSPlatform("browser")]
	public sealed partial class BrowserWebSocketConnection : NetworkConnection
	{
		internal const int RecvCapacity = 256 * 1024;
		internal const int SendCapacity = 128 * 1024;

		// Transport command kinds served to JS by the pump.
		internal const int WorkCreate = 1;
		internal const int WorkSend = 2;
		internal const int WorkClose = 3;

		static int nextId;

		// Live connections by interop id; JS callbacks arrive on this thread, so a plain
		// dictionary is enough (no cross-thread visibility concerns under wasm).
		static readonly Dictionary<int, BrowserWebSocketConnection> Live = new();
		// Connections whose close command is still queued: the shim may still be
		// copying bytes through the pinned buffers until it has served the close,
		// so pins are released only when that command completes (MpWorkDone).
		static readonly Dictionary<int, BrowserWebSocketConnection> Closing = new();
		static readonly Queue<int> WorkKinds = new();
		static readonly Queue<int> WorkIds = new();
		static readonly Queue<byte[]> WorkPayloads = new();
		static bool workServed;
		static int headOffset;

		readonly Uri endpoint;
		readonly WsFrameAssembler assembler = new();
		readonly ConcurrentQueue<byte[]> receivedChunks = [];
		readonly byte[] recvBuffer = new byte[RecvCapacity];
		readonly byte[] sendBuffer = new byte[SendCapacity];
		readonly int id;
		readonly int recvPtr;
		readonly int sendPtr;
		GCHandle recvPin;
		GCHandle sendPin;
		int pinsReleased;
		volatile bool transportDisposed;

		public BrowserWebSocketConnection(Uri endpoint)
			: base(CreateTarget(endpoint))
		{
			if (endpoint.Scheme != Uri.UriSchemeWs && endpoint.Scheme != Uri.UriSchemeWss)
				throw new ArgumentException("WebSocket endpoints must use the ws or wss scheme.", nameof(endpoint));

			this.endpoint = endpoint;
			id = ++nextId;

			recvPin = GCHandle.Alloc(recvBuffer, GCHandleType.Pinned);
			sendPin = GCHandle.Alloc(sendBuffer, GCHandleType.Pinned);
			unsafe
			{
				fixed (byte* p = recvBuffer)
					recvPtr = (int)p;
				fixed (byte* p = sendBuffer)
					sendPtr = (int)p;
			}

			Live.Add(id, this);
			EnqueueWork(WorkCreate, id, null);
		}

		static ConnectionTarget CreateTarget(Uri endpoint)
		{
			ArgumentNullException.ThrowIfNull(endpoint);
			return new ConnectionTarget(endpoint.Host, endpoint.Port);
		}

		void EnqueueWork(int kind, int workId, byte[] payload)
		{
			WorkKinds.Enqueue(kind);
			WorkIds.Enqueue(workId);
			WorkPayloads.Enqueue(payload);
		}

		internal static void WsOnOpen(int id)
		{
			if (Live.TryGetValue(id, out var conn))
				conn.OnOpen();
		}

		internal static void WsOnMessage(int id, int length)
		{
			if (Live.TryGetValue(id, out var conn))
				conn.OnMessage(length);
		}

		internal static void WsOnError(int id)
		{
			if (Live.TryGetValue(id, out var conn))
				conn.OnError();
		}

		internal static void WsOnClose(int id)
		{
			if (Live.TryGetValue(id, out var conn))
				conn.OnClose();
		}

		void OnOpen()
		{
			// The server-side handshake bytes arrive as the first ws payload; nothing to
			// do beyond noting that the transport itself is up.
			Console.WriteLine($"[mp] websocket open: {endpoint}");
		}

		void OnMessage(int length)
		{
			try
			{
				if (length <= 0 || length > recvBuffer.Length)
					throw new InvalidDataException($"WebSocket payload out of range: {length}.");

				var chunk = new byte[length];
				Buffer.BlockCopy(recvBuffer, 0, chunk, 0, length);
				receivedChunks.Enqueue(chunk);
			}
			catch (Exception ex)
			{
				FailConnection(ex);
			}
		}

		void OnError()
		{
			if (!transportDisposed && ConnectionState != ConnectionState.NotConnected)
				Console.WriteLine($"[mp] websocket error: {endpoint}");
		}

		void OnClose()
		{
			if (!transportDisposed && ConnectionState != ConnectionState.NotConnected)
				FailConnection(new InvalidOperationException("The remote endpoint closed the connection."));
		}

		protected override void PumpTransport()
		{
			if (ConnectionState == ConnectionState.NotConnected)
				return;

			try
			{
				while (receivedChunks.TryDequeue(out var chunk))
					assembler.Push(chunk);

				if (assembler.TryTakeHandshake(out var protocol, out var clientId))
					CompleteHandshake(protocol, clientId);

				while (assembler.TryTakeFrame(out var fromClient, out var data))
					EnqueueReceivedPacket(fromClient, data);
			}
			catch (Exception ex)
			{
				FailConnection(ex);
			}
		}

		protected override void SendBytes(MemoryStream ms)
		{
			ObjectDisposedException.ThrowIf(transportDisposed, this);

			// The frame stream is chunked through the pinned send buffer at pump-serve
			// time; the receiver reframes by length prefix, so chunk boundaries are
			// irrelevant.
			EnqueueWork(WorkSend, id, ms.ToArray());
		}

		protected override void DisposeTransport()
		{
			transportDisposed = true;
			Live.Remove(id);
			// The shim may still address the pinned buffers until it has served
			// the close queued below; ReleasePins happens in MpWorkDone then.
			Closing[id] = this;
			EnqueueWork(WorkClose, id, null);
		}

		void FailConnection(Exception ex)
		{
			if (transportDisposed || ConnectionState == ConnectionState.NotConnected)
				return;

			ErrorMessage = $"Connection failed: {ex.Message}";
			Log.Write("client", $"WebSocket connection to {endpoint} failed: {ex.Message}");
			SetConnectionState(ConnectionState.NotConnected);
			Live.Remove(id);
			Closing[id] = this;
			EnqueueWork(WorkClose, id, null);
		}

		void ReleasePins()
		{
			if (Interlocked.Exchange(ref pinsReleased, 1) == 0)
			{
				recvPin.Free();
				sendPin.Free();
			}
		}

		// ---- pump-facing state (served by the JS presentation pump) ----

		static int servedKind;
		static int servedId;
		static int servedSendLen;

			internal static bool MpHasWork()
		{
			if (WorkKinds.Count == 0)
				return false;

			if (!workServed)
			{
				servedKind = WorkKinds.Peek();
				servedId = WorkIds.Peek();
				servedSendLen = 0;

			if (servedKind == WorkCreate)
			{
				if (Live.TryGetValue(servedId, out var create))
				{
					// Publish the create payload alongside the queued command.
					CreatePayloadUrl = create.endpoint.ToString();
					CreatePayloadRecvPtr = create.recvPtr;
					CreatePayloadRecvCap = create.recvBuffer.Length;
					CreatePayloadSendPtr = create.sendPtr;
					CreatePayloadSendCap = create.sendBuffer.Length;
				}
				else
				{
					// The connection died before its create was served: serve a
					// no-op kind the shim ignores; the queued close that follows
					// releases the pins.
					servedKind = 0;
					CreatePayloadUrl = "";
					CreatePayloadRecvPtr = 0;
					CreatePayloadRecvCap = 0;
					CreatePayloadSendPtr = 0;
					CreatePayloadSendCap = 0;
				}
			}

			if (servedKind == WorkSend)
			{
				var payload = WorkPayloads.Peek();
				var conn = Live.TryGetValue(servedId, out var c) ? c : null;
				if (conn != null)
				{
					// Continue the head payload at headOffset: a Send larger
					// than the send buffer is chunked in place, never re-enqueued
					// behind later items.
					servedSendLen = Math.Min(payload.Length - headOffset, conn.sendBuffer.Length);
					Buffer.BlockCopy(payload, headOffset, conn.sendBuffer, 0, servedSendLen);
				}
			}

				workServed = true;
			}

			return true;
		}

			internal static int MpWorkKind() => servedKind;

			internal static int MpWorkId() => servedId;

			internal static int MpSendLen() => servedSendLen;

		internal static string CreatePayloadUrl = "";
		internal static int CreatePayloadRecvPtr;
		internal static int CreatePayloadRecvCap;
		internal static int CreatePayloadSendPtr;
		internal static int CreatePayloadSendCap;

			internal static string MpWorkUrl() => CreatePayloadUrl;

			internal static int MpRecvPtr() => CreatePayloadRecvPtr;

			internal static int MpRecvCap() => CreatePayloadRecvCap;

			internal static int MpSendPtr() => CreatePayloadSendPtr;

			internal static int MpSendCap() => CreatePayloadSendCap;

		internal static void MpWorkDone()
		{
			if (!workServed)
				return;

			// A Send larger than the send buffer keeps its head item and
			// advances headOffset; the tail is never re-queued behind other items.
			if (servedKind == WorkSend)
			{
				var payload = WorkPayloads.Peek();
				headOffset += servedSendLen;
				if (payload.Length > headOffset && Live.TryGetValue(servedId, out var conn))
				{
					workServed = false;
					return;
				}
			}

			// The served close is what the shim was waiting for: only now may
			// the pinned buffers be released.
			if (servedKind == WorkClose && Closing.Remove(servedId, out var closing))
				closing.ReleasePins();

			WorkKinds.Dequeue();
			WorkIds.Dequeue();
			WorkPayloads.Dequeue();
			headOffset = 0;
			workServed = false;
		}
	}
}
