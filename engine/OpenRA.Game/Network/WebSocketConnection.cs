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

using System;
using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net.WebSockets;
using System.Threading;
using System.Threading.Tasks;

namespace OpenRA.Network
{
	sealed class WsFrameAssembler
	{
		const int HandshakeLength = 8;
		const int FrameHeaderLength = 8;
		const int MaxOrderLength = OpenRA.Server.Connection.MaxOrderLength;

		readonly Queue<(int FromClient, byte[] Data)> frames = [];
		byte[] buffer = [];
		int bufferOffset;
		int bufferLength;
		bool handshakeComplete;
		bool handshakePending;
		int handshakeProtocol;
		int localClientId;

		public void Push(ReadOnlySpan<byte> data)
		{
			Append(data);
			Parse();
		}

		public bool TryTakeHandshake(out int protocol, out int clientId)
		{
			if (!handshakePending)
			{
				protocol = default;
				clientId = default;
				return false;
			}

			handshakePending = false;
			protocol = handshakeProtocol;
			clientId = localClientId;
			return true;
		}

		public bool TryTakeFrame(out int fromClient, out byte[] data)
		{
			if (!frames.TryDequeue(out var frame))
			{
				fromClient = default;
				data = null;
				return false;
			}

			fromClient = frame.FromClient;
			data = frame.Data;
			return true;
		}

		void Append(ReadOnlySpan<byte> data)
		{
			if (data.IsEmpty)
				return;

			var required = checked(bufferLength + data.Length);
			if (buffer.Length - bufferOffset < required)
			{
				if (buffer.Length < required)
				{
					var capacity = Math.Max(required, Math.Max(256, buffer.Length * 2));
					var replacement = new byte[capacity];
					buffer.AsSpan(bufferOffset, bufferLength).CopyTo(replacement);
					buffer = replacement;
				}
				else
					buffer.AsSpan(bufferOffset, bufferLength).CopyTo(buffer);

				bufferOffset = 0;
			}

			data.CopyTo(buffer.AsSpan(bufferOffset + bufferLength));
			bufferLength += data.Length;
		}

		void Parse()
		{
			if (!handshakeComplete)
			{
				if (bufferLength < HandshakeLength)
					return;

				var handshake = buffer.AsSpan(bufferOffset, HandshakeLength);
				handshakeProtocol = BinaryPrimitives.ReadInt32LittleEndian(handshake);
				localClientId = BinaryPrimitives.ReadInt32LittleEndian(handshake[4..]);
				handshakeComplete = true;
				handshakePending = true;
				Consume(HandshakeLength);
			}

			while (bufferLength >= FrameHeaderLength)
			{
				var header = buffer.AsSpan(bufferOffset, FrameHeaderLength);
				var length = BinaryPrimitives.ReadInt32LittleEndian(header);
				if (length < sizeof(int) || length - sizeof(int) > MaxOrderLength)
					throw new InvalidDataException($"Invalid server frame length {length}.");

				var wireLength = checked(FrameHeaderLength + length);
				if (bufferLength < wireLength)
					return;

				var fromClient = BinaryPrimitives.ReadInt32LittleEndian(header[4..]);
				frames.Enqueue((fromClient, buffer.AsSpan(bufferOffset + FrameHeaderLength, length).ToArray()));
				Consume(wireLength);
			}
		}

		void Consume(int length)
		{
			bufferOffset += length;
			bufferLength -= length;
			if (bufferLength == 0)
				bufferOffset = 0;
		}
	}

	public sealed class WebSocketConnection : NetworkConnection
	{
		const int ReceiveBufferSize = 16 * 1024;

		readonly Uri endpoint;
		readonly ClientWebSocket socket = new();
		readonly CancellationTokenSource cancellation = new();
		readonly SemaphoreSlim sendSignal = new(0);
		readonly ConcurrentQueue<byte[]> receivedChunks = [];
		readonly ConcurrentQueue<byte[]> sendQueue = [];
		readonly WsFrameAssembler assembler = new();
		volatile bool transportDisposed;

		public WebSocketConnection(Uri endpoint)
			: base(CreateTarget(endpoint))
		{
			if (endpoint.Scheme != Uri.UriSchemeWs && endpoint.Scheme != Uri.UriSchemeWss)
				throw new ArgumentException("WebSocket endpoints must use the ws or wss scheme.", nameof(endpoint));

			this.endpoint = endpoint;
			_ = RunAsync();
		}

		static ConnectionTarget CreateTarget(Uri endpoint)
		{
			ArgumentNullException.ThrowIfNull(endpoint);
			return new ConnectionTarget(endpoint.Host, endpoint.Port);
		}

		async Task RunAsync()
		{
			try
			{
				await socket.ConnectAsync(endpoint, cancellation.Token);
				var receiveTask = ReceiveLoopAsync();
				var sendTask = SendLoopAsync();
				var completedTask = await Task.WhenAny(receiveTask, sendTask);
				await completedTask;
				if (!transportDisposed)
					FailConnection(new WebSocketException("The remote endpoint closed the connection."));
			}
			catch (OperationCanceledException) when (transportDisposed || cancellation.IsCancellationRequested)
			{
			}
			catch (Exception ex)
			{
				FailConnection(ex);
			}
			finally
			{
				await cancellation.CancelAsync();
				sendSignal.Release();
			}
		}

		async Task ReceiveLoopAsync()
		{
			var buffer = new byte[ReceiveBufferSize];
			while (!cancellation.IsCancellationRequested)
			{
				var result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellation.Token);
				if (result.MessageType == WebSocketMessageType.Close)
					return;

				if (result.MessageType != WebSocketMessageType.Binary)
					throw new InvalidDataException($"Unexpected WebSocket message type {result.MessageType}.");

				if (result.Count != 0)
					receivedChunks.Enqueue(buffer.AsSpan(0, result.Count).ToArray());
			}
		}

		async Task SendLoopAsync()
		{
			while (!cancellation.IsCancellationRequested)
			{
				await sendSignal.WaitAsync(cancellation.Token);
				while (sendQueue.TryDequeue(out var data))
					await socket.SendAsync(
						new ArraySegment<byte>(data), WebSocketMessageType.Binary, true, cancellation.Token);
			}
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
			sendQueue.Enqueue(ms.ToArray());
			sendSignal.Release();
		}

		protected override void DisposeTransport()
		{
			transportDisposed = true;
			cancellation.Cancel();
			sendSignal.Release();
			socket.Dispose();
		}

		void FailConnection(Exception ex)
		{
			if (transportDisposed || ConnectionState == ConnectionState.NotConnected)
				return;

			ErrorMessage = "Connection failed";
			Log.Write("client", $"WebSocket connection to {endpoint} failed: {ex.Message}");
			SetConnectionState(ConnectionState.NotConnected);
			cancellation.Cancel();
			sendSignal.Release();
			socket.Abort();
		}
	}
}
