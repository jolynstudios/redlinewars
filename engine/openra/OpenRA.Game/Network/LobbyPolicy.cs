using System.Linq;

namespace OpenRA.Network
{
	public static class LobbyPolicy
	{
		public static string StartReason(Session lobby, int availableSpawns)
		{
			var players = lobby.Clients.Where(c => c.Slot != null).ToArray();
			if (lobby.Slots.Any(s => s.Value.Required && lobby.ClientInSlot(s.Key) == null))
				return "Required map seats must be occupied.";
			if (!players.Any(c => !c.IsBot))
				return "At least one human player must take a seat.";
			if (players.Any(c => !c.IsBot && c.State != Session.ClientState.Ready))
				return "Every seated human must be ready.";
			if (lobby.GlobalSettings.Ranked && players.Count(c => !c.IsBot) < 2)
				return "Ranked requires at least two human players.";
			if (!lobby.GlobalSettings.EnableSingleplayer && players.Length < 2)
				return "At least two opponents are required.";
			if (players.Length > 1 && players.All(c => c.Team > 0 && c.Team == players[0].Team))
				return "Players need an opposing team.";
			if (availableSpawns > 0 && players.Length > availableSpawns - lobby.DisabledSpawnPoints.Count)
				return "The map needs enough enabled spawn points.";
			return null;
		}
	}
}
