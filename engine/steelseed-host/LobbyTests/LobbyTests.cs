using System;
using System.Linq;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;
using System.Runtime.CompilerServices;
using NUnit.Framework;
using OpenRA.Mods.Common.Server;
using OpenRA.Network;
using OpenRA.Server;

namespace OpenRA.Tests
{
	[TestFixture]
	public class LobbyTests
	{
		static Session Lobby(bool bot = true)
		{
			var lobby = new Session();
			for (var i = 0; i < 5; i++)
				lobby.Slots.Add($"Multi{i}", new Session.Slot { PlayerReference = $"Multi{i}" });
			lobby.Clients.Add(new Session.Client { Index = 1, Slot = "Multi0", State = Session.ClientState.Ready, Name = "One" });
			lobby.Clients.Add(new Session.Client { Index = 2, Slot = "Multi1", State = Session.ClientState.Ready, Name = "Two", Bot = bot ? "normal" : null });
			lobby.Clients.Add(new Session.Client { Index = 3, IsAdmin = true, State = Session.ClientState.NotReady, Name = "Observer admin" });
			return lobby;
		}

		[Test]
		public void UnrankedHumanAndAiCanStartWithThreeVacantOptionalSeatsAndObserverAdmin()
		{
			Assert.That(LobbyPolicy.StartReason(Lobby(), 5), Is.Null);
		}

		[Test]
		public void ObserverAdminAndBotsOnlyMustWaitForASeatedHuman()
		{
			var lobby = Lobby();
			lobby.Clients[0].Bot = "normal";
			Assert.That(LobbyPolicy.StartReason(lobby, 5), Is.EqualTo("At least one human player must take a seat."));
		}

		[Test]
		public void RequiredSeatsReadinessOpposingTeamsAndRankedHumansAreEnforced()
		{
			var lobby = Lobby();
			lobby.Slots["Multi4"].Required = true;
			Assert.That(LobbyPolicy.StartReason(lobby, 5), Is.EqualTo("Required map seats must be occupied."));
			lobby.Slots["Multi4"].Required = false;
			lobby.Clients[0].State = Session.ClientState.NotReady;
			Assert.That(LobbyPolicy.StartReason(lobby, 5), Is.EqualTo("Every seated human must be ready."));
			lobby.Clients[0].State = Session.ClientState.Ready;
			lobby.Clients[0].Team = lobby.Clients[1].Team = 1;
			Assert.That(LobbyPolicy.StartReason(lobby, 5), Is.EqualTo("Players need an opposing team."));
			lobby.Clients[1].Team = 2;
			lobby.GlobalSettings.Ranked = true;
			Assert.That(LobbyPolicy.StartReason(lobby, 5), Is.EqualTo("Ranked requires at least two human players."));
			lobby.Clients[1].Bot = null;
			Assert.That(LobbyPolicy.StartReason(lobby, 5), Is.Null);
		}

		[Test]
		public void EnabledSpawnRequirementCountsOccupiedSeatsAndSupportsMapsWithoutSpawns()
		{
			var lobby = Lobby();
			lobby.DisabledSpawnPoints.Add(1);
			Assert.That(LobbyPolicy.StartReason(lobby, 2), Is.EqualTo("The map needs enough enabled spawn points."));
			Assert.That(LobbyPolicy.StartReason(lobby, 5), Is.Null);
			Assert.That(LobbyPolicy.StartReason(lobby, 0), Is.Null);
		}

		[Test]
		public void AdminTransferRequiresAnotherHumanAndEachSuccessorReceivesFreshTerm()
		{
			var lease = new LobbyAdminLease();
			lease.ObserveAdmin(1, 0);
			Assert.That(lease.Successor(1, new[] { 1 }, true, 900000, 600000), Is.Null);
			Assert.That(lease.Successor(1, new[] { 1, 2 }, false, 900000, 600000), Is.Null);
			lease.Activity(1, 900000);
			Assert.That(lease.Successor(1, new[] { 1, 2 }, true, 1499999, 600000), Is.Null);
			Assert.That(lease.Successor(1, new[] { 1, 2 }, true, 1500000, 600000), Is.EqualTo(2));
			Assert.That(lease.Successor(2, new[] { 1, 2 }, true, 1500001, 600000), Is.Null);
			Assert.That(lease.Successor(2, new[] { 1, 2 }, true, 2100000, 600000), Is.EqualTo(1));
		}

		[Test]
		public void ExternalAdminPromotionResetsLeaseAndDisabledLeaseNeverTransfers()
		{
			var lease = new LobbyAdminLease();
			lease.ObserveAdmin(1, 0);
			Assert.That(lease.Successor(2, new[] { 1, 2 }, true, 600000, 600000), Is.Null);
			Assert.That(lease.Successor(2, new[] { 1, 2 }, true, 1200000, 0), Is.Null);
		}

		[Test]
		public void ChatHasBoundedMemoryAndNoBacklogForNewSession()
		{
			var chat = new EphemeralLobbyChat();
			var sender = Lobby().Clients[0];
			for (var i = 0; i < 130; i++)
				chat.Add(sender, $"message {i}");
			Assert.That(chat.Messages.Count(), Is.EqualTo(100));
			Assert.That(chat.Messages.First().Text, Is.EqualTo("message 30"));
			Assert.That(new EphemeralLobbyChat().Messages, Is.Empty);
			chat.Clear();
			Assert.That(chat.Messages, Is.Empty);
		}

		[Test]
		public void ChatSanitizesControlsAndEnforcesLength()
		{
			Assert.That(EphemeralLobbyChat.Sanitize(" \nHello\u0000\t "), Is.EqualTo("Hello"));
			Assert.That(EphemeralLobbyChat.Sanitize(new string('x', 1000)).Length, Is.EqualTo(512));
			Assert.That(EphemeralLobbyChat.Sanitize(null), Is.Empty);
		}

		[Test]
		public void ReplayFilterRemovesCommunicationButPreservesMixedControlOrders()
		{
			var mixed = new OrderPacket(new[] {
				Order.Command("state Ready"),
				Order.FromTargetString("LobbyChat", "SECRET-CLIENT", true),
				Order.FromTargetString("LobbyChatMessage", "SECRET-ECHO", true, 2),
				Order.FromTargetString("Chat", "SECRET-NATIVE", true),
				Order.FromTargetString("LobbyChatAccepted", "", true, 7),
				Order.FromTargetString("LobbyChatRejected", "retry", true, 8)
			}).Serialize(0);
			var filtered = EphemeralLobbyChat.WithoutCommunication(mixed);
			Assert.That(OrderIO.TryParseOrderPacket(filtered, out var packet), Is.True);
			Assert.That(packet.Orders.GetOrders(null).Select(o => o.TargetString), Is.EqualTo(new[] { "state Ready" }));
			Assert.That(EphemeralLobbyChat.WithoutCommunication(new OrderPacket(new[] { Order.FromTargetString("LobbyChat", "secret", true) }).Serialize(0)), Is.Null);
		}

		[Test]
		public void ClearingOrderManagerOnStartAndDisposeRemovesTransientChat()
		{
			using var manager = new OrderManager(new EchoConnection());
			manager.LobbyInfo = Lobby();
			manager.LobbyChat.Add(manager.LobbyInfo.Clients[0], "before start");
			manager.StartGame();
			Assert.That(manager.LobbyChat.Messages, Is.Empty);
			manager.LobbyChat.Add(manager.LobbyInfo.Clients[0], "before dispose");
			manager.Dispose();
			Assert.That(manager.LobbyChat.Messages, Is.Empty);
		}

		sealed class DisconnectingConnection : NetworkConnection
		{
			public DisconnectingConnection() : base(new ConnectionTarget("localhost", 1234)) { }
			public void QueueEchoBeforeClose() => EnqueueReceivedPacket(0,
				new OrderPacket(new[] { Order.FromTargetString("LobbyChatMessage", "queued before transport closed", true, 1) }).Serialize(0));
			protected override void PumpTransport() => SetConnectionState(ConnectionState.NotConnected);
			protected override void SendBytes(MemoryStream stream) { }
			protected override void DisposeTransport() { }
		}

		[Test]
		public void AbruptTransportCloseClearsChatWhileOrderManagerStillExists()
		{
			using var manager = new OrderManager(new DisconnectingConnection());
			manager.LobbyInfo = Lobby();
			manager.LobbyChat.Add(manager.LobbyInfo.Clients[0], "before abrupt close");
			manager.TickImmediate();
			Assert.That(manager.LobbyChat.Messages, Is.Empty);
		}

		[Test]
		public void QueuedServerEchoCannotRestoreChatAfterAnAbruptTransportClose()
		{
			var connection = new DisconnectingConnection();
			using var manager = new OrderManager(connection);
			manager.LobbyInfo = Lobby();
			connection.QueueEchoBeforeClose();
			manager.TickImmediate();
			Assert.That(manager.LobbyChat.Messages, Is.Empty);
		}

		[Test]
		public void RecorderNeverBuffersCommunicationPayloadBeforeTheReplayStarts()
		{
			var recorder = new ReplayRecorder(() => throw new Exception("No file should be written."));
			var secret = "CONFIDENTIAL-TEXT-UNIQUE";
			recorder.Receive(1, new OrderPacket(new[] { Order.FromTargetString("LobbyChat", secret, true) }).Serialize(0));
			recorder.ReceiveFrame(0, 0, Order.FromTargetString("LobbyChatMessage", secret, true, 1).Serialize());
			var buffer = (MemoryStream)typeof(ReplayRecorder).GetField("preStartBuffer", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(recorder);
			Assert.That(buffer.Length, Is.Zero);
			recorder.Receive(1, new OrderPacket(new[] { Order.Command("state Ready"), Order.FromTargetString("Chat", secret, true) }).Serialize(0));
			Assert.That(buffer.Length, Is.GreaterThan(0));
			Assert.That(Encoding.UTF8.GetString(buffer.ToArray()), Does.Not.Contain(secret));
			recorder.Dispose();
		}

		[Test]
		public void OnlyMatchingServerAcknowledgementCompletesTheSinglePendingSend()
		{
			using var manager = new OrderManager(new EchoConnection());
			manager.LobbyInfo = Lobby();
			var request = manager.LobbyChat.BeginSend();
			Assert.That(manager.LobbyChat.BeginSend(), Is.Zero, "Only one request can be pending.");
			var accepted = Order.FromTargetString("LobbyChatAccepted", "", true, request);
			manager.ReceiveImmediateOrders(2, new OrderPacket(new[] { accepted }));
			Assert.That(manager.LobbyChat.SendStatus(request), Is.EqualTo("pending"), "A peer cannot acknowledge a request.");
			manager.ReceiveImmediateOrders(0, new OrderPacket(new[] { Order.FromTargetString("LobbyChatAccepted", "", true, request + 1) }));
			Assert.That(manager.LobbyChat.SendStatus(request), Is.EqualTo("pending"), "A stale acknowledgement cannot complete a request.");
			manager.ReceiveImmediateOrders(0, new OrderPacket(new[] { accepted }));
			Assert.That(manager.LobbyChat.SendStatus(request), Is.EqualTo("accepted"));
			var next = manager.LobbyChat.BeginSend();
			manager.ReceiveImmediateOrders(0, new OrderPacket(new[] { Order.FromTargetString("LobbyChatRejected", "Retry shortly.", true, next) }));
			Assert.That(manager.LobbyChat.SendStatus(next), Is.EqualTo("Retry shortly."));
			manager.LobbyChat.Clear();
			Assert.That(manager.LobbyChat.SendStatus(next), Is.EqualTo("chat session ended"));
		}

		[Test]
		public void ProductionServerAcknowledgesJoinCooldownRefusalAndConfirmsSuccessfulEcho()
		{
			var server = (OpenRA.Server.Server)RuntimeHelpers.GetUninitializedObject(typeof(OpenRA.Server.Server));
			server.LobbyInfo = new Session();
			server.Settings = new ServerSettings { FloodLimitJoinCooldown = 5000 };
			server.State = ServerState.WaitingPlayers;
			var connections = new List<OpenRA.Server.Connection>();
			typeof(OpenRA.Server.Server).GetField("Conns").SetValue(server, connections);
			var link = new InMemoryLink();
			using var connection = new OpenRA.Server.Connection(server, link, "test");
			connection.Validated = true;
			connections.Add(connection);
			server.LobbyInfo.Clients.Add(new Session.Client { Index = connection.PlayerIndex, Name = "Late joiner" });
			// The in-memory transport's handshake preamble is sent before ordinary server frames.
			connection.TrySendData(new byte[8]);
			link.ServerToClient.TryDequeue(out _);
			var trackerType = typeof(OpenRA.Server.Server).Assembly.GetType("OpenRA.Server.PlayerMessageTracker");
			var tracker = Activator.CreateInstance(trackerType, server,
				(Action<OpenRA.Server.Connection, int, int, byte[]>)((_, _, _, _) => { }),
				(Action<OpenRA.Server.Connection, string, object[]>)((_, _, _) => { }));
			typeof(OpenRA.Server.Server).GetField("playerMessageTracker", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(server, tracker);
			var interpret = typeof(OpenRA.Server.Server).GetMethod("InterpretServerOrder", BindingFlags.Instance | BindingFlags.NonPublic);
			Order[] Drain()
			{
				var orders = new List<Order>();
				while (link.ServerToClient.TryDequeue(out var frame))
				{
					Assert.That(OrderIO.TryParseOrderPacket(frame[4..], out var packet), Is.True);
					orders.AddRange(packet.Orders.GetOrders(null));
				}
				return orders.ToArray();
			}

			interpret.Invoke(server, new object[] { connection, Order.FromTargetString("LobbyChat", "never silently lose this draft", true, 7) });
			var refused = Drain();
			Assert.That(refused.Select(o => o.OrderString), Is.EqualTo(new[] { "LobbyChatRejected" }));
			Assert.That(refused[0].ExtraData, Is.EqualTo(7));
			Assert.That(refused[0].TargetString, Does.Contain("rate limited").And.Not.Contain("draft"));
			server.Settings.FloodLimitJoinCooldown = 0;
			interpret.Invoke(server, new object[] { connection, Order.FromTargetString("LobbyChat", "delivered", true, 8) });
			var confirmed = Drain();
			Assert.That(confirmed.Select(o => o.OrderString), Is.EqualTo(new[] { "LobbyChatMessage", "LobbyChatAccepted" }));
			Assert.That(confirmed[0].TargetString, Is.EqualTo("delivered"));
			Assert.That(confirmed[1].ExtraData, Is.EqualTo(8));
			Assert.That(confirmed[1].TargetString, Is.Empty);
		}

		[TestCase("map another")]
		[TestCase("capacity 5")]
		[TestCase("ambience night on")]
		[TestCase("slot_bot Multi2 1 normal")]
		[TestCase("faction 1 england")]
		[TestCase("team 1 2")]
		[TestCase("spawn 1 2")]
		[TestCase("option joa-companion True")]
		public void RankedRejectsImmutableCommandsAtProductionServerBoundary(string command)
		{
			var server = (OpenRA.Server.Server)RuntimeHelpers.GetUninitializedObject(typeof(OpenRA.Server.Server));
			server.LobbyInfo = Lobby();
			server.Settings = new ServerSettings { Ranked = true };
			Assert.That(LobbyCommands.ValidateCommand(server, null, server.LobbyInfo.Clients[2], command), Is.False);
		}
	}
}
