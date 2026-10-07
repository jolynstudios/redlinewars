using System;
using System.Collections.Generic;
using System.Linq;

namespace OpenRA.Server
{
	// Ping packets do not renew this lease. Only deliberate lobby actions do.
	public sealed class LobbyAdminLease
	{
		int admin = -1;
		long lastActivity;

		public void ObserveAdmin(int index, long now)
		{
			if (admin == index)
				return;
			admin = index;
			lastActivity = now;
		}

		public void Activity(int index, long now)
		{
			ObserveAdmin(index, now);
			lastActivity = now;
		}

		public int? Successor(int index, IEnumerable<int> humans, bool lobby, long now, long timeout)
		{
			ObserveAdmin(index, now);
			if (!lobby || timeout <= 0 || now - lastActivity < timeout)
				return null;
			var candidates = humans.Where(i => i != index).OrderBy(i => i).ToArray();
			if (candidates.Length == 0)
				return null;
			admin = candidates[0];
			lastActivity = now;
			return admin;
		}
	}
}
