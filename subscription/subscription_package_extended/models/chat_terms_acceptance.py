# -*- coding: utf-8 -*-
from odoo import models, fields


class ChatTermsAcceptance(models.Model):
    _name = 'chat.terms.acceptance'
    _description = 'Chat Terms Acceptance'
    _rec_name = 'user_id'

    user_id = fields.Many2one(
        'res.partner',
        required=True,
        ondelete='cascade'
    )

    partner_id = fields.Many2one(
        'res.partner',
        required=True,
        ondelete='cascade'
    )

    accepted_date = fields.Datetime(
        default=fields.Datetime.now
    )

    _sql_constraints = [
        (
            'unique_terms_acceptance',
            'unique(user_id, partner_id)',
            'Terms already accepted for this user.'
        )
    ]
