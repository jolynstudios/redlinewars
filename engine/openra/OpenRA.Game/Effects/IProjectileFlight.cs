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

using OpenRA.GameRules;

namespace OpenRA.Effects
{
	/// <summary>
	/// Read-only flight state of a live projectile, for a renderer that has no WorldRenderer.
	/// <para>
	/// STEELSEED addition. Upstream every projectile keeps its position private and publishes it
	/// only through <see cref="IEffect.Render"/>, which needs sprite sequences, a palette and a
	/// WorldRenderer — none of which exist in the browser host, because the browser draws from a
	/// binary snapshot instead of from renderables. Without this the snapshot could carry a
	/// projectile channel that nothing on the host could ever fill, and the client would draw no
	/// rocket for a V2, a SAM or a rocket soldier, and no arc for a tesla coil.
	/// </para>
	/// <para>
	/// PRESENTATION ONLY. Every member is a getter over state the projectile already keeps; none
	/// of them is called from the simulation, none mutates anything, and none participates in the
	/// sync hash. Implementing it cannot change what a projectile does.
	/// </para>
	/// </summary>
	public interface IProjectileFlight
	{
		/// <summary>Current world position of the projectile, or the muzzle end of a beam.</summary>
		WPos FlightPosition { get; }

		/// <summary>Displacement per simulation tick. <see cref="WVec.Zero"/> for a beam.</summary>
		WVec FlightVelocity { get; }

		/// <summary>
		/// Where the projectile is going. For a beam this is the far end and IS an enemy position,
		/// so the publisher is responsible for withholding it behind fog.
		/// </summary>
		WPos FlightTarget { get; }

		/// <summary>Ticks until removal, or -1 when the projectile homes and cannot know.</summary>
		int FlightRemainingTicks { get; }

		/// <summary>
		/// True when this is an instantaneous source-to-target effect (a tesla zap, a laser)
		/// rather than a body travelling through the air.
		/// </summary>
		bool FlightIsBeam { get; }

		/// <summary>The weapon that created it, so a client can pick its authored visual.</summary>
		WeaponInfo FlightWeapon { get; }

		/// <summary>The firing actor, or 0. Lets a client raise a launch onto the drawn barrel.</summary>
		uint FlightSourceActorId { get; }
		/// <summary>Immutable launch facts; never a current muzzle query.</summary>
		WPos FlightLaunchPosition { get; }
		ushort FlightArmament { get; }
		ushort FlightBarrel { get; }
		uint FlightShot { get; }

		/// <summary>
		/// False while the projectile exists but has not left its launcher yet: a missile silo's
		/// launch delay. The publisher skips it until then, so nothing is drawn waiting in the silo.
		/// </summary>
		bool FlightLaunched => true;
	}
}
