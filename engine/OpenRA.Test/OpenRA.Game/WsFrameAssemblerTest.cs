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
using System.IO;
using NUnit.Framework;
using OpenRA.Network;

namespace OpenRA.Test
{
	[TestFixture]
	sealed class WsFrameAssemblerTest
	{
		const int ClientId = 3;

		static readonly byte[] Handshake =
		[
			0x07, 0x00, 0x00, 0x00,
			ClientId, 0x00, 0x00, 0x00
		];

		static byte[] CreateFrame(int fromClient, int frame, params byte[] orders)
		{
			var result = new byte[12 + orders.Length];
			BinaryPrimitives.WriteInt32LittleEndian(result, orders.Length + sizeof(int));
			BinaryPrimitives.WriteInt32LittleEndian(result.AsSpan(4), fromClient);
			BinaryPrimitives.WriteInt32LittleEndian(result.AsSpan(8), frame);
			orders.CopyTo(result, 12);
			return result;
		}

		static byte[] Combine(params byte[][] chunks)
		{
			var length = 0;
			foreach (var chunk in chunks)
				length += chunk.Length;

			var result = new byte[length];
			var offset = 0;
			foreach (var chunk in chunks)
			{
				chunk.CopyTo(result, offset);
				offset += chunk.Length;
			}

			return result;
		}

		static void AssertHandshake(WsFrameAssembler assembler)
		{
			Assert.That(assembler.TryTakeHandshake(out var protocol, out var clientId), Is.True);
			Assert.That(protocol, Is.EqualTo(OpenRA.Server.ProtocolVersion.Handshake));
			Assert.That(clientId, Is.EqualTo(ClientId));
			Assert.That(assembler.TryTakeHandshake(out _, out _), Is.False);
		}

		static void AssertFrame(WsFrameAssembler assembler, int expectedClient, int expectedFrame, byte[] expectedOrders)
		{
			Assert.That(assembler.TryTakeFrame(out var fromClient, out var data), Is.True);
			Assert.That(fromClient, Is.EqualTo(expectedClient));
			Assert.That(BinaryPrimitives.ReadInt32LittleEndian(data), Is.EqualTo(expectedFrame));
			Assert.That(data[4..], Is.EqualTo(expectedOrders));
		}

		[TestCase(TestName = "WebSocket framing survives a one-byte drip")]
		public void FramingSurvivesOneByteDrip()
		{
			var assembler = new WsFrameAssembler();
			var ack = CreateFrame(0, 1, (byte)OrderType.Ack, 1);
			foreach (var value in Combine(Handshake, ack))
				assembler.Push([value]);

			AssertHandshake(assembler);
			AssertFrame(assembler, 0, 1, [(byte)OrderType.Ack, 1]);
			Assert.That(assembler.TryTakeFrame(out _, out _), Is.False);
		}

		[TestCase(TestName = "WebSocket framing survives a split length header")]
		public void FramingSurvivesSplitLengthHeader()
		{
			var assembler = new WsFrameAssembler();
			var stream = Combine(Handshake, CreateFrame(2, 0x11223344, (byte)OrderType.Ack, 2));
			assembler.Push(stream.AsSpan(0, Handshake.Length + 2));

			AssertHandshake(assembler);
			Assert.That(assembler.TryTakeFrame(out _, out _), Is.False);

			assembler.Push(stream.AsSpan(Handshake.Length + 2));
			AssertFrame(assembler, 2, 0x11223344, [(byte)OrderType.Ack, 2]);
		}

		[TestCase(TestName = "WebSocket framing extracts two merged frames")]
		public void FramingExtractsTwoMergedFrames()
		{
			var assembler = new WsFrameAssembler();
			assembler.Push(Combine(
				Handshake,
				CreateFrame(1, 7, (byte)OrderType.Ack, 1),
				CreateFrame(2, 8, (byte)OrderType.Ack, 2)));

			AssertHandshake(assembler);
			AssertFrame(assembler, 1, 7, [(byte)OrderType.Ack, 1]);
			AssertFrame(assembler, 2, 8, [(byte)OrderType.Ack, 2]);
			Assert.That(assembler.TryTakeFrame(out _, out _), Is.False);
		}

		[TestCase(TestName = "WebSocket framing rejects oversized orders")]
		public void FramingRejectsOversizedOrders()
		{
			var header = new byte[8];
			BinaryPrimitives.WriteInt32LittleEndian(
				header, OpenRA.Server.Connection.MaxOrderLength + sizeof(int) + 1);
			var assembler = new WsFrameAssembler();
			assembler.Push(Handshake);

			Assert.That(() => assembler.Push(header), Throws.TypeOf<InvalidDataException>());
		}
	}
}
