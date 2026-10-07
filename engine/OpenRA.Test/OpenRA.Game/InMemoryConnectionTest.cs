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

using System.IO;
using NUnit.Framework;
using OpenRA.Network;

namespace OpenRA.Test
{
	[TestFixture]
	sealed class InMemoryConnectionTest
	{
		static byte[] ReconstructClientStream(InMemoryLink link)
		{
			var stream = new MemoryStream();
			foreach (var (frame, data) in link.ClientToServer)
			{
				stream.Write(data.Length + 4);
				stream.Write(frame);
				stream.Write(data);
			}

			return stream.ToArray();
		}

		[TestCase(TestName = "In-memory client framing matches the TCP wire format")]
		public void ClientFramingMatchesTcpWireFormat()
		{
			var link = new InMemoryLink();
			using var connection = (IConnection)new InMemoryNetworkConnection(link);

			connection.SendSync(0x11223344, 0x55667788, 0x0102030405060708);
			connection.Send(0x0A0B0C0D, []);

			var expected = new byte[]
			{
				0x04, 0x00, 0x00, 0x00,
				0x0D, 0x0C, 0x0B, 0x0A,
				0x11, 0x00, 0x00, 0x00,
				0x44, 0x33, 0x22, 0x11,
				(byte)OrderType.SyncHash,
				0x88, 0x77, 0x66, 0x55,
				0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01
			};

			Assert.That(ReconstructClientStream(link), Is.EqualTo(expected));
		}

		[TestCase(TestName = "In-memory server framing completes the handshake and delivers acknowledgements")]
		public void ServerFramingCompletesHandshakeAndDeliversAcknowledgements()
		{
			const int ClientId = 3;
			var link = new InMemoryLink();
			link.ServerToClient.Enqueue([
				0x07, 0x00, 0x00, 0x00,
				ClientId, 0x00, 0x00, 0x00]);

			var networkConnection = new InMemoryNetworkConnection(link);
			using var orderManager = new OrderManager(networkConnection);
			var connection = (IConnection)networkConnection;
			connection.Receive(orderManager);

			Assert.That(networkConnection.ConnectionState, Is.EqualTo(ConnectionState.Connected));
			Assert.That(connection.LocalClientId, Is.EqualTo(ClientId));

			orderManager.LobbyInfo.Clients.Add(new Session.Client { Index = ClientId });
			orderManager.StartGame();
			connection.Send(1, []);

			link.ServerToClient.Enqueue([
				0x00, 0x00, 0x00, 0x00,
				0x01, 0x00, 0x00, 0x00,
				(byte)OrderType.Ack, 0x01]);
			connection.Receive(orderManager);

			Assert.That(orderManager.OrderQueueLength, Is.EqualTo(1));

			link.ServerClosed = true;
			connection.Receive(orderManager);
			Assert.That(networkConnection.ConnectionState, Is.EqualTo(ConnectionState.NotConnected));
		}
	}
}
