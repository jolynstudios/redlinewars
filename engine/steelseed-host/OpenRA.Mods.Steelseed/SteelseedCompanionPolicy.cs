using System.Collections.Generic;
using OpenRA.Mods.Common.Traits;
using OpenRA.Traits;

namespace OpenRA.Mods.Steelseed
{
	[TraitLocation(SystemActors.World)]
	public sealed class SteelseedCompanionPolicyInfo : TraitInfo, ILobbyOptions
	{
		IEnumerable<LobbyOption> ILobbyOptions.LobbyOptions(MapPreview map)
		{
			yield return new LobbyBooleanOption(map, "joa-companion",
				"checkbox-joa-companion.label", "checkbox-joa-companion.description",
				true, 95, true, false);
		}

		public override object Create(ActorInitializer init) { return new SteelseedCompanionPolicy(); }
	}

	// Captured once when the world is created. A running game cannot change host policy.
	public sealed class SteelseedCompanionPolicy : INotifyCreated
	{
		public bool Enabled { get; private set; }
		void INotifyCreated.Created(Actor self)
		{
			Enabled = self.World.LobbyInfo.GlobalSettings.OptionOrDefault("joa-companion", true);
		}
	}
}
