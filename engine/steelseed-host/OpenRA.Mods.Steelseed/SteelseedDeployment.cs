using System;
using System.Linq;
using OpenRA.Mods.Common.Traits;
using OpenRA.Mods.Common.Traits.Render;
using OpenRA.Primitives;
using OpenRA.Traits;

namespace OpenRA.Mods.Steelseed
{
	/// <summary>Presentation provenance only. Does not change transform timing, conditions or orders.</summary>
	public sealed class SteelseedDeploymentInfo : TraitInfo
	{
		public override object Create(ActorInitializer init) => new SteelseedDeployment(init, this);
	}

	public sealed class SteelseedDeployment : ITransformActorInitModifier
	{
		readonly SteelseedDeploymentInfo info;
		public readonly uint SourceActorId;
		public readonly WPos SourcePosition;
		public readonly WAngle SourceFacing;
		public readonly int CreatedTick;

		public SteelseedDeployment(ActorInitializer init, SteelseedDeploymentInfo info)
		{
			this.info = info;
			SourceActorId = init.GetValue<SteelseedDeploySourceInit, uint>(info, 0);
			SourcePosition = init.GetValue<SteelseedDeployPositionInit, WPos>(info, WPos.Zero);
			SourceFacing = init.GetValue<SteelseedDeployFacingInit, WAngle>(info, WAngle.Zero);
			CreatedTick = init.World.WorldTick;
		}

		void ITransformActorInitModifier.ModifyTransformActorInit(Actor self, TypeDictionary init)
		{
			if (self.Info.Name != "mcv") return;

			// The new yard gets a different ActorID. Copy values, never retain the disposed actor.
			init.Add(new SteelseedDeploySourceInit(info, self.ActorID));
			init.Add(new SteelseedDeployPositionInit(info, self.CenterPosition));
			init.Add(new SteelseedDeployFacingInit(info, self.TraitOrDefault<IFacing>()?.Facing ?? WAngle.Zero));
		}

		public bool TryMakeFrame(Actor self, out ushort frame, out ushort frames, out ushort frameMilliseconds)
		{
			frame = frames = frameMilliseconds = 0;
			if (SourceActorId == 0 || self.Info.Name != "fact") return false;
			var body = self.TraitsImplementing<WithSpriteBody>().FirstOrDefault(b => !b.IsTraitDisabled);
			var animation = body?.DefaultAnimation;
			if (animation?.CurrentSequence?.Name != "make") return true; // Completed or explicitly skipped.
			frames = (ushort)Math.Clamp(animation.CurrentSequence.Length, 1, ushort.MaxValue);
			frame = (ushort)Math.Clamp(animation.CurrentFrame, 0, frames - 1);
			frameMilliseconds = (ushort)Math.Clamp(animation.CurrentSequence.Tick, 1, ushort.MaxValue);
			return true;
		}
	}

	public sealed class SteelseedDeploySourceInit : ValueActorInit<uint>
	{
		public SteelseedDeploySourceInit(TraitInfo info, uint value)
			: base(info, value) { }
	}

	public sealed class SteelseedDeployPositionInit : ValueActorInit<WPos>
	{
		public SteelseedDeployPositionInit(TraitInfo info, WPos value)
			: base(info, value) { }
	}

	public sealed class SteelseedDeployFacingInit : ValueActorInit<WAngle>
	{
		public SteelseedDeployFacingInit(TraitInfo info, WAngle value)
			: base(info, value) { }
	}
}
