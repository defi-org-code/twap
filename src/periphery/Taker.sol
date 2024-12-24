// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import "../IExchange.sol";
import "../OrderLib.sol";
import "../TWAP.sol";

/**
 * Helper contract for TWAP takers
 * optionally swaps fee to native token at fill
 */
contract Taker {
    using SafeERC20 for ERC20;

    TWAP public twap;
    IAllowed public allowed;

    constructor() {}

    function init(TWAP _twap, IAllowed _allowed) external {
        if (address(twap) != address(0) || address(allowed) != address(0)) revert();
        twap = _twap;
        allowed = _allowed;
    }

    /**
     * Perform bid
     */
    function bid(uint64 id, address exchange, uint256 dstFee, uint32 slippagePercent, bytes calldata data)
        external
        onlyAllowed
    {
        twap.bid(id, exchange, dstFee, slippagePercent, data);
    }

    function fill(uint64 id, address ref, uint256 dstSenderAmount, address feeSwapExchange, bytes calldata feeSwapData)
        external
        onlyAllowed
    {
        twap.fill(id);
        OrderLib.Order memory o = twap.order(id);

        if (o.ask.dstToken != twap.iweth() && o.ask.dstToken != address(0) && feeSwapExchange != address(0)) {
            ERC20(o.ask.dstToken).safeIncreaseAllowance(feeSwapExchange, dstSenderAmount);
            IExchange(feeSwapExchange).swap(o.ask.dstToken, twap.iweth(), dstSenderAmount, 0, o.ask.data, feeSwapData);
        }

        if (ERC20(twap.iweth()).balanceOf(address(this)) > 0) {
            IWETH(twap.iweth()).withdraw(ERC20(twap.iweth()).balanceOf(address(this)));
        }

        rescue(o.ask.dstToken, msg.sender, dstSenderAmount);
        rescue(
            o.ask.dstToken,
            ref,
            o.ask.dstToken == address(0) ? ERC20(o.ask.dstToken).balanceOf(address(this)) : address(this).balance
        );
    }

    function rescue(address token, address to, uint256 amount) public onlyAllowed {
        if (token != address(0)) ERC20(token).safeTransfer(to, amount);
        else Address.sendValue(payable(to), amount);
    }

    receive() external payable {} // solhint-disable-line no-empty-blocks

    error NotAllowed(address caller);

    modifier onlyAllowed() {
        if (!allowed.allowed(msg.sender)) revert NotAllowed(msg.sender);
        _;
    }
}

interface IAllowed {
    function allowed(address) external view returns (bool);
}
