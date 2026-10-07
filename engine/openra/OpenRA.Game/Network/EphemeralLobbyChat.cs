using System;
using System.Collections.Generic;
using System.Linq;

namespace OpenRA.Network
{
	// This buffer belongs to one OrderManager only. It never enters Session,
	// notifications, replay metadata, settings, or browser persistence.
	public sealed class EphemeralLobbyChat
	{
		public const int MaxMessages = 100;
		public const int MaxTextLength = 512;
		public sealed record Message(int Sequence, int ClientIndex, string Name, string Text);
		readonly Queue<Message> messages = new();
		int sequence;
		uint nextRequest;
		uint request;
		string requestStatus;

		public uint BeginSend()
		{
			if (requestStatus == "pending")
				return 0;
			request = ++nextRequest;
			requestStatus = "pending";
			return request;
		}

		public string SendStatus(uint id) => id == request ? requestStatus : "chat session ended";

		public void ConfirmSend(uint id, string error = null)
		{
			if (id == request && requestStatus == "pending")
				requestStatus = error ?? "accepted";
		}
		public IEnumerable<Message> Messages => messages;

		public static string Sanitize(string text) => string.IsNullOrWhiteSpace(text) ? "" :
			new string(text.Where(c => !char.IsControl(c)).Take(MaxTextLength).ToArray()).Trim();

		public void Add(Session.Client sender, string text)
		{
			text = Sanitize(text);
			if (sender == null || text.Length == 0)
				return;
			messages.Enqueue(new Message(++sequence, sender.Index, sender.Name, text));
			while (messages.Count > MaxMessages)
				messages.Dequeue();
		}

		public void Clear()
		{
			messages.Clear();
			request = 0;
			requestStatus = null;
		}

		// Called by both client and server ReplayRecorder. Preserve other orders
		// in mixed immediate packets while removing all communication payloads.
		public static byte[] WithoutCommunication(byte[] data)
		{
			if (!OrderIO.TryParseOrderPacket(data, out var packet) || packet.Frame != 0)
				return data;
			var orders = packet.Orders.GetOrders(null).ToArray();
			var retained = orders.Where(o => o.OrderString != "LobbyChat" && o.OrderString != "LobbyChatMessage" && o.OrderString != "LobbyChatAccepted" && o.OrderString != "LobbyChatRejected" && o.OrderString != "Chat").ToArray();
			return retained.Length == orders.Length ? data : retained.Length == 0 ? null : new OrderPacket(retained).Serialize(0);
		}
	}
}
